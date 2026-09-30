const crypto = require("node:crypto");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { mkdtemp, rm } = require("node:fs/promises");
const express = require("express");
const { WebSocketServer, WebSocket } = require("ws");
const pty = require("node-pty");
const { parseRepository } = require("./repository");

const PORT = Number(process.env.PORT || 3000);
const APP_PASSWORD = process.env.APP_PASSWORD;
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const MAX_REPOSITORIES_PER_SESSION = 3;
const MAX_TERMINALS_PER_SESSION = 10;
const MAX_TERMINAL_OUTPUT_LENGTH = 100000;

if (!APP_PASSWORD || APP_PASSWORD.length < 24 || !GITHUB_TOKEN) {
  throw new Error(
    "Set APP_PASSWORD (at least 24 characters) and GITHUB_TOKEN before starting the server."
  );
}

const app = express();
const sessions = new Map();
const repositories = new Map();
const terminals = new Map();
const sessionSockets = new Map();
let cloneRunning = false;

app.disable("x-powered-by");
app.use(express.json({ limit: "16kb" }));

function sendJson(res, status, body) {
  res.status(status).json(body);
}

function passwordMatches(candidate) {
  const expected = crypto.createHash("sha256").update(APP_PASSWORD).digest();
  const actual = crypto.createHash("sha256").update(candidate).digest();
  return crypto.timingSafeEqual(expected, actual);
}

function getCookie(req, name) {
  const cookies = req.headers.cookie || "";
  for (const part of cookies.split(";")) {
    const separator = part.indexOf("=");
    if (separator !== -1 && part.slice(0, separator).trim() === name) {
      return part.slice(separator + 1).trim();
    }
  }
  return null;
}

function getSession(req) {
  const key = getCookie(req, "copilot_session");
  if (!key) return null;
  const session = sessions.get(key);
  if (!session || session.expiresAt <= Date.now()) {
    removeSession(key);
    return null;
  }
  return session;
}

function removeSession(key) {
  sessions.delete(key);
  const sessionRepos = repositories.get(key);
  repositories.delete(key);
  const sessionTerminals = terminals.get(key);
  terminals.delete(key);
  if (sessionTerminals) {
    for (const terminal of sessionTerminals.values()) {
      if (!terminal.exited) terminal.pty.kill();
    }
  }
  if (!sessionRepos) return;
  for (const repo of sessionRepos.values()) {
    rm(repo.path, { recursive: true, force: true }).catch((error) => {
      console.error(`Failed to remove temporary repository ${repo.name}: ${error.message}`);
    });
  }
}

const sessionCleanupTimer = setInterval(() => {
  for (const [key, session] of sessions) {
    if (session.expiresAt <= Date.now()) removeSession(key);
  }
}, 60 * 1000);
sessionCleanupTimer.unref();

function safeSend(socket, data) {
  if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(data));
}

function sendToSession(sessionId, data) {
  for (const socket of sessionSockets.get(sessionId) || []) safeSend(socket, data);
}

function broadcast(data) {
  for (const sockets of sessionSockets.values()) {
    for (const socket of sockets) safeSend(socket, data);
  }
}

function publicTerminal(terminal) {
  return {
    id: terminal.id,
    repoId: terminal.repoId,
    repoName: terminal.repoName,
    output: terminal.output,
    exited: terminal.exited
  };
}

function appendTerminalOutput(terminal, text) {
  terminal.output += text;
  if (terminal.output.length > MAX_TERMINAL_OUTPUT_LENGTH) {
    terminal.output = terminal.output.slice(-MAX_TERMINAL_OUTPUT_LENGTH);
  }
  sendToSession(terminal.ownerId, { type: "terminal-output", terminalId: terminal.id, text });
}

function runCommand(command, args, options, timeoutMs, onOutput) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      ...options,
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
      windowsHide: true
    });
    let settled = false;
    let timedOut = false;
    let forceKillTimeout;
    const timeout = setTimeout(() => {
      timedOut = true;
      killProcessTree("SIGTERM");
      forceKillTimeout = setTimeout(() => killProcessTree("SIGKILL"), 5000);
    }, timeoutMs);

    function killProcessTree(signal) {
      if (process.platform !== "win32" && child.pid) {
        try {
          process.kill(-child.pid, signal);
          return;
        } catch (error) {
          if (error.code !== "ESRCH") {
            console.error(`Failed to signal child process group: ${error.message}`);
          }
        }
      }
      child.kill(signal);
    }

    function finish(error, code) {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      clearTimeout(forceKillTimeout);
      if (error) reject(error);
      else if (code !== 0) reject(new Error(`Polecenie zakończyło się kodem ${code}.`));
      else resolve();
    }

    child.stdout.on("data", (chunk) => onOutput(chunk.toString()));
    child.stderr.on("data", (chunk) => onOutput(chunk.toString()));
    child.on("error", (error) => finish(error));
    child.on("close", (code) => {
      if (timedOut) finish(new Error("Przekroczono limit czasu polecenia."));
      else finish(null, code);
    });
  });
}

function childEnvironment() {
  const env = { ...process.env };
  delete env.APP_PASSWORD;
  delete env.GITHUB_TOKEN;
  delete env.GH_TOKEN;
  delete env.COPILOT_GITHUB_TOKEN;
  delete env.COPILOT_HOME;
  return env;
}

app.get("/healthz", (_req, res) => sendJson(res, 200, { ok: true }));

app.get("/vendor/xterm.js", (_req, res) => {
  res.sendFile(path.join(__dirname, "node_modules", "@xterm", "xterm", "lib", "xterm.js"));
});

app.get("/vendor/xterm.css", (_req, res) => {
  res.sendFile(path.join(__dirname, "node_modules", "@xterm", "xterm", "css", "xterm.css"));
});

app.get("/vendor/addon-fit.js", (_req, res) => {
  res.sendFile(path.join(__dirname, "node_modules", "@xterm", "addon-fit", "lib", "addon-fit.js"));
});

app.get("/", (req, res) => {
  if (!getSession(req)) return res.redirect("/login");
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.get("/login", (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "login.html"));
});

app.post("/api/login", (req, res) => {
  const password = req.body && req.body.password;
  if (typeof password !== "string" || !passwordMatches(password)) {
    return sendJson(res, 401, { error: "Nieprawidłowe hasło." });
  }

  const key = crypto.randomBytes(32).toString("hex");
  sessions.set(key, { id: key, expiresAt: Date.now() + SESSION_TTL_MS });
  const forwardedProto = req.headers["x-forwarded-proto"];
  const isSecure = process.env.NODE_ENV === "production" ||
    (forwardedProto && forwardedProto.split(",")[0].trim() === "https");
  const secure = isSecure ? "; Secure" : "";
  res.setHeader("Set-Cookie", `copilot_session=${key}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_TTL_MS / 1000}${secure}`);
  return sendJson(res, 200, { ok: true });
});

app.post("/api/logout", (req, res) => {
  const key = getCookie(req, "copilot_session");
  if (key) removeSession(key);
  const forwardedProto = req.headers["x-forwarded-proto"];
  const isSecure = process.env.NODE_ENV === "production" ||
    (forwardedProto && forwardedProto.split(",")[0].trim() === "https");
  const secure = isSecure ? "; Secure" : "";
  res.setHeader("Set-Cookie", `copilot_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0${secure}`);
  return sendJson(res, 200, { ok: true });
});

app.get("/api/session", (req, res) => {
  if (!getSession(req)) return sendJson(res, 401, { error: "Zaloguj się ponownie." });
  return sendJson(res, 200, { ok: true });
});

const server = app.listen(PORT, "0.0.0.0", () => {
  console.log(`Web app listening on port ${PORT}`);
});

const webSockets = new WebSocketServer({ noServer: true, maxPayload: 256 * 1024 });

server.on("upgrade", (req, socket, head) => {
  const forwardedProto = req.headers["x-forwarded-proto"];
  const protocol = forwardedProto ? forwardedProto.split(",")[0].trim() : "http";
  const expectedOrigin = `${protocol}://${req.headers.host}`;
  if (req.headers.origin !== expectedOrigin || req.url !== "/ws") {
    socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
    socket.destroy();
    return;
  }

  const session = getSession(req);
  if (!session) {
    socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
    socket.destroy();
    return;
  }

  webSockets.handleUpgrade(req, socket, head, (ws) => {
    ws.session = session;
    webSockets.emit("connection", ws);
  });
});

webSockets.on("connection", (socket) => {
  let sessionRepos = repositories.get(socket.session.id);
  if (!sessionRepos) {
    sessionRepos = new Map();
    repositories.set(socket.session.id, sessionRepos);
  }
  let sessionTerminals = terminals.get(socket.session.id);
  if (!sessionTerminals) {
    sessionTerminals = new Map();
    terminals.set(socket.session.id, sessionTerminals);
  }
  let sockets = sessionSockets.get(socket.session.id);
  if (!sockets) {
    sockets = new Set();
    sessionSockets.set(socket.session.id, sockets);
  }
  sockets.add(socket);

  safeSend(socket, {
    type: "ready",
    repos: [...sessionRepos.entries()].map(([id, repo]) => ({ id, name: repo.name })),
    terminals: [...sessionTerminals.values()].map(publicTerminal)
  });

  socket.on("message", async (raw) => {
    if (!sessions.has(socket.session.id) || socket.session.expiresAt <= Date.now()) {
      removeSession(socket.session.id);
      socket.close(1008, "Sesja wygasła");
      return;
    }
    let message;
    try {
      message = JSON.parse(raw.toString());
    } catch {
      return safeSend(socket, { type: "error", text: "Nieprawidłowy format wiadomości." });
    }
    if (!message || typeof message !== "object") {
      return safeSend(socket, { type: "error", text: "Nieprawidłowa wiadomość." });
    }

    if (message.type === "terminal-create") {
      const repoId = typeof message.repoId === "string" ? message.repoId : "";
      const repo = sessionRepos.get(repoId);
      if (!repo) return safeSend(socket, { type: "error", text: "Najpierw sklonuj i wybierz repozytorium." });
      if (sessionTerminals.size >= MAX_TERMINALS_PER_SESSION) {
        return safeSend(socket, { type: "error", text: `Można utworzyć maksymalnie ${MAX_TERMINALS_PER_SESSION} terminali.` });
      }
      const shell = process.platform === "win32"
        ? (process.env.COMSPEC || "powershell.exe")
        : (process.env.SHELL || "/bin/bash");
      let terminal;
      try {
        const processTerminal = pty.spawn(shell, process.platform === "win32" ? [] : ["-i"], {
          name: "xterm-256color",
          cols: 80,
          rows: 24,
          cwd: repo.path,
          env: { ...childEnvironment(), TERM: "xterm-256color" }
        });
        terminal = {
          id: crypto.randomUUID(),
          ownerId: socket.session.id,
          repoId,
          repoName: repo.name,
          output: "",
          exited: false,
          pty: processTerminal
        };
        sessionTerminals.set(terminal.id, terminal);
        processTerminal.onData((text) => appendTerminalOutput(terminal, text));
        processTerminal.onExit(() => {
          terminal.exited = true;
          sendToSession(terminal.ownerId, { type: "terminal-exit", terminalId: terminal.id });
        });
        return safeSend(socket, { type: "terminal-created", terminal: publicTerminal(terminal) });
      } catch (error) {
        if (terminal) {
          sessionTerminals.delete(terminal.id);
          if (!terminal.exited) terminal.pty.kill();
        }
        return safeSend(socket, { type: "error", text: `Nie udało się uruchomić terminala: ${error.message}` });
      }
    }

    if (message.type === "terminal-input") {
      const terminalId = typeof message.terminalId === "string" ? message.terminalId : "";
      const terminal = sessionTerminals.get(terminalId);
      if (!terminal) return safeSend(socket, { type: "error", text: "Nie znaleziono terminala." });
      if (terminal.exited) return safeSend(socket, { type: "error", text: "Ten terminal został już zamknięty." });
      if (typeof message.data !== "string" || message.data.length > 60 * 1024) {
        return safeSend(socket, { type: "error", text: "Nieprawidłowe dane wejściowe terminala." });
      }
      terminal.pty.write(message.data);
      return;
    }

    if (message.type === "terminal-resize") {
      const terminalId = typeof message.terminalId === "string" ? message.terminalId : "";
      const terminal = sessionTerminals.get(terminalId);
      if (!terminal) return safeSend(socket, { type: "error", text: "Nie znaleziono terminala." });
      if (
        !Number.isInteger(message.cols) || message.cols < 2 || message.cols > 300 ||
        !Number.isInteger(message.rows) || message.rows < 1 || message.rows > 100
      ) {
        return safeSend(socket, { type: "error", text: "Nieprawidłowy rozmiar terminala." });
      }
      if (!terminal.exited) terminal.pty.resize(message.cols, message.rows);
      return;
    }

    if (message.type === "terminal-close") {
      const terminalId = typeof message.terminalId === "string" ? message.terminalId : "";
      const terminal = sessionTerminals.get(terminalId);
      if (!terminal) return safeSend(socket, { type: "error", text: "Nie znaleziono terminala." });
      sessionTerminals.delete(terminalId);
      if (!terminal.exited) terminal.pty.kill();
      return safeSend(socket, { type: "terminal-closed", terminalId });
    }

    if (message.type === "terminal-clear") {
      const terminalId = typeof message.terminalId === "string" ? message.terminalId : "";
      const terminal = sessionTerminals.get(terminalId);
      if (!terminal) return safeSend(socket, { type: "error", text: "Nie znaleziono terminala." });
      terminal.output = "";
      return safeSend(socket, { type: "terminal-cleared", terminalId });
    }

    if (message.type === "terminal-signal") {
      const terminalId = typeof message.terminalId === "string" ? message.terminalId : "";
      const terminal = sessionTerminals.get(terminalId);
      if (!terminal) return safeSend(socket, { type: "error", text: "Nie znaleziono terminala." });
      if (!terminal.exited) terminal.pty.write("\u0003");
      return;
    }

    if (message.type === "clone") {
      const name = parseRepository(message.repo);
      if (!name) {
        return safeSend(socket, { type: "error", text: "Podaj repozytorium GitHub w formacie owner/repo." });
      }
      if (cloneRunning) {
        return safeSend(socket, { type: "error", text: "Inne repozytorium jest już klonowane." });
      }
      if (sessionRepos.size >= MAX_REPOSITORIES_PER_SESSION) {
        return safeSend(socket, { type: "error", text: "Limit repozytoriów w tej sesji został osiągnięty." });
      }

      cloneRunning = true;
      broadcast({ type: "clone-state", busy: true });
      safeSend(socket, { type: "log", text: `Klonowanie ${name}...\n` });
      let workspace;
      try {
        workspace = await mkdtemp(path.join(os.tmpdir(), "copilot-repo-"));
        const id = crypto.randomUUID();
        const auth = Buffer.from(`x-access-token:${GITHUB_TOKEN}`).toString("base64");
        const env = childEnvironment();
        env.GIT_TERMINAL_PROMPT = "0";
        env.GIT_CONFIG_COUNT = "1";
        env.GIT_CONFIG_KEY_0 = "http.extraheader";
        env.GIT_CONFIG_VALUE_0 = `AUTHORIZATION: basic ${auth}`;
        await runCommand(
          "git",
          ["clone", "--progress", "--", `https://github.com/${name}.git`, workspace],
          { cwd: os.tmpdir(), env },
          10 * 60 * 1000,
          (text) => safeSend(socket, { type: "log", text })
        );
        sessionRepos.set(id, { name, path: workspace });
        safeSend(socket, { type: "repo", id, name });
        safeSend(socket, { type: "log", text: `Gotowe: ${name}\n` });
      } catch (error) {
        if (workspace) {
          try {
            await rm(workspace, { recursive: true, force: true });
          } catch (cleanupError) {
            console.error(`Failed to remove temporary repository ${name}: ${cleanupError.message}`);
          }
        }
        safeSend(socket, { type: "error", text: `Nie udało się sklonować repozytorium: ${error.message}` });
      } finally {
        cloneRunning = false;
        broadcast({ type: "clone-state", busy: false });
      }
      return;
    }

    safeSend(socket, { type: "error", text: "Nieznany typ polecenia." });
  });

  socket.on("close", () => {
    sockets.delete(socket);
    if (sockets.size === 0) sessionSockets.delete(socket.session.id);
  });
});

module.exports = server;
