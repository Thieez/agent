const crypto = require("node:crypto");
const path = require("node:path");
const { access } = require("node:fs/promises");
const express = require("express");
const { WebSocketServer, WebSocket } = require("ws");
const pty = require("node-pty");
const { terminalEnvironment } = require("./child-environment");

const PORT = Number(process.env.PORT || 3000);
const APP_PASSWORD = process.env.APP_PASSWORD;
const GUP_ROOT = path.resolve(process.env.GUP_ROOT || path.join(__dirname, "gup"));
const SESSION_COOKIE_NAME = "repo_agent_session";
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const MAX_TERMINALS_PER_SESSION = 10;
const MAX_TERMINAL_OUTPUT_LENGTH = 100000;

if (!APP_PASSWORD || APP_PASSWORD.length < 24) {
  throw new Error("Set APP_PASSWORD (at least 24 characters) before starting the server.");
}

const app = express();
const sessions = new Map();
const terminals = new Map();
const sessionSockets = new Map();

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
  const key = getCookie(req, SESSION_COOKIE_NAME);
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
  const sessionTerminals = terminals.get(key);
  terminals.delete(key);
  if (!sessionTerminals) return;
  for (const terminal of sessionTerminals.values()) {
    if (!terminal.exited) terminal.pty.kill();
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

function publicTerminal(terminal) {
  return {
    id: terminal.id,
    name: terminal.name,
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
  res.setHeader("Set-Cookie", `${SESSION_COOKIE_NAME}=${key}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_TTL_MS / 1000}${secure}`);
  return sendJson(res, 200, { ok: true });
});

app.post("/api/logout", (req, res) => {
  const key = getCookie(req, SESSION_COOKIE_NAME);
  if (key) removeSession(key);
  const forwardedProto = req.headers["x-forwarded-proto"];
  const isSecure = process.env.NODE_ENV === "production" ||
    (forwardedProto && forwardedProto.split(",")[0].trim() === "https");
  const secure = isSecure ? "; Secure" : "";
  res.setHeader("Set-Cookie", `${SESSION_COOKIE_NAME}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0${secure}`);
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
      if (sessionTerminals.size >= MAX_TERMINALS_PER_SESSION) {
        return safeSend(socket, { type: "error", text: `Można utworzyć maksymalnie ${MAX_TERMINALS_PER_SESSION} terminali.` });
      }
      const gupScriptPath = path.join(GUP_ROOT, "gup.ps1");
      try {
        await access(gupScriptPath);
      } catch (error) {
        if (error.code !== "ENOENT") {
          console.error(`Could not check gup.ps1 at ${gupScriptPath}: ${error.message}`);
          return safeSend(socket, { type: "error", text: `Nie udało się sprawdzić skryptu gup.ps1: ${error.message}` });
        }
        console.error(`gup.ps1 was not found at ${gupScriptPath}.`);
        return safeSend(socket, {
          type: "error",
          text: `Nie znaleziono skryptu gup.ps1 w ${GUP_ROOT}. Sprawdź checkout gup lub zmienną GUP_ROOT.`
        });
      }

      const shell = process.platform === "win32"
        ? "powershell.exe"
        : (process.env.PWSH_PATH || path.join(__dirname, "node_modules", ".bin", "pwsh"));
      if (process.platform !== "win32") {
        try {
          await access(shell);
        } catch (error) {
          if (error.code !== "ENOENT") {
            console.error(`Could not check PowerShell at ${shell}: ${error.message}`);
            return safeSend(socket, { type: "error", text: `Nie udało się sprawdzić PowerShell: ${error.message}` });
          }
          console.error(`PowerShell was not found at ${shell}.`);
          return safeSend(socket, {
            type: "error",
            text: `Nie znaleziono PowerShell pod ścieżką ${shell}. Uruchom ponownie usługę, aby zainstalować PowerShell.`
          });
        }
      }

      try {
        const gupScript = gupScriptPath.replace(/'/g, "''");
        const processTerminal = pty.spawn(shell, [
          "-NoLogo",
          "-NoExit",
          "-Command",
          `. '${gupScript}'`
        ], {
          name: "xterm-256color",
          cols: 80,
          rows: 24,
          cwd: GUP_ROOT,
          env: { ...terminalEnvironment(), TERM: "xterm-256color" }
        });
        const terminal = {
          id: crypto.randomUUID(),
          ownerId: socket.session.id,
          name: `gup (${sessionTerminals.size + 1})`,
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
        console.error(`Failed to start gup terminal in ${GUP_ROOT}: ${error.message}`);
        return safeSend(socket, {
          type: "error",
          text: error.code === "ENOENT"
            ? `Nie udało się uruchomić PowerShell z ${shell}. Uruchom ponownie usługę lub sprawdź instalację powłoki.`
            : `Nie udało się uruchomić terminala gup: ${error.message}`
        });
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

    safeSend(socket, { type: "error", text: "Nieznany typ polecenia." });
  });

  socket.on("close", () => {
    sockets.delete(socket);
    if (sockets.size === 0) sessionSockets.delete(socket.session.id);
  });
});

module.exports = server;
