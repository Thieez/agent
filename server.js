const crypto = require("node:crypto");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { mkdir, mkdtemp, rm } = require("node:fs/promises");
const express = require("express");
const { WebSocketServer, WebSocket } = require("ws");
const { parseRepository } = require("./repository");

const PORT = Number(process.env.PORT || 3000);
const APP_PASSWORD = process.env.APP_PASSWORD;
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
let copilotToken = process.env.COPILOT_GITHUB_TOKEN || null;
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const MAX_REPOSITORIES_PER_SESSION = 3;
const MAX_PROMPT_LENGTH = 8000;
const COPILOT_ENTRY = path.join(__dirname, "node_modules", "@github", "copilot", "npm-loader.js");
const COPILOT_HOME = path.join(os.tmpdir(), `copilot-home-${crypto.randomUUID()}`);

if (!APP_PASSWORD || APP_PASSWORD.length < 24 || !GITHUB_TOKEN) {
  throw new Error(
    "Set APP_PASSWORD (at least 24 characters) and GITHUB_TOKEN before starting the server."
  );
}

const app = express();
const sessions = new Map();
const repositories = new Map();
let commandRunning = false;
let copilotAuthenticated = Boolean(copilotToken);

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

function runCommand(socket, command, args, options, timeoutMs) {
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

    child.stdout.on("data", (chunk) => safeSend(socket, { type: "log", text: chunk.toString() }));
    child.stderr.on("data", (chunk) => safeSend(socket, { type: "log", text: chunk.toString() }));
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
  env.COPILOT_HOME = COPILOT_HOME;
  return env;
}

function copilotEnvironment() {
  const env = childEnvironment();
  if (copilotToken) env.COPILOT_GITHUB_TOKEN = copilotToken;
  return env;
}

app.get("/healthz", (_req, res) => sendJson(res, 200, { ok: true }));

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

const webSockets = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024 });

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

  safeSend(socket, {
    type: "ready",
    copilotAuthenticated,
    copilotTokenConfigured: Boolean(copilotToken),
    repos: [...sessionRepos.entries()].map(([id, repo]) => ({ id, name: repo.name }))
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
    if (commandRunning) {
      return safeSend(socket, { type: "error", text: "Inne zadanie jest już uruchomione." });
    }

    if (message.type === "copilot-token") {
      const token = typeof message.token === "string" ? message.token.trim() : "";
      if (
        token.length > 4096 ||
        !/^(?:gho_|github_pat_|ghu_)[A-Za-z0-9_]+$/.test(token)
      ) {
        return safeSend(socket, {
          type: "error",
          text: "Nieprawidłowy token. Użyj tokenu OAuth (gho_), fine-grained PAT (github_pat_) lub tokenu GitHub App (ghu_)."
        });
      }
      copilotToken = token;
      copilotAuthenticated = true;
      safeSend(socket, { type: "copilot-token-saved" });
      safeSend(socket, { type: "copilot-authenticated", authenticated: true });
      return;
    }

    if (message.type === "copilot-login") {
      commandRunning = true;
      safeSend(socket, { type: "busy", busy: true });
      safeSend(socket, { type: "log", text: "\nRozpoczynam logowanie Copilot przez konto GitHub.\n" });
      try {
        await mkdir(COPILOT_HOME, { recursive: true });
        await runCommand(
          socket,
          process.execPath,
          [COPILOT_ENTRY, "login", "--device-code"],
          { cwd: os.tmpdir(), env: childEnvironment() },
          10 * 60 * 1000
        );
        copilotAuthenticated = true;
        safeSend(socket, { type: "copilot-authenticated", authenticated: true });
        safeSend(socket, { type: "log", text: "\nLogowanie Copilot zakończone.\n" });
      } catch (error) {
        safeSend(socket, { type: "error", text: `Logowanie Copilot nie powiodło się: ${error.message}` });
      } finally {
        commandRunning = false;
        safeSend(socket, { type: "busy", busy: false });
      }
      return;
    }

    if (message.type === "clone") {
      const name = parseRepository(message.repo);
      if (!name) {
        return safeSend(socket, { type: "error", text: "Podaj repozytorium GitHub w formacie owner/repo." });
      }
      if (sessionRepos.size >= MAX_REPOSITORIES_PER_SESSION) {
        return safeSend(socket, { type: "error", text: "Limit repozytoriów w tej sesji został osiągnięty." });
      }

      commandRunning = true;
      safeSend(socket, { type: "busy", busy: true });
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
          socket,
          "git",
          ["clone", "--progress", "--", `https://github.com/${name}.git`, workspace],
          { cwd: os.tmpdir(), env },
          10 * 60 * 1000
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
        commandRunning = false;
        safeSend(socket, { type: "busy", busy: false });
      }
      return;
    }

    if (message.type === "prompt") {
      if (!copilotAuthenticated) {
        return safeSend(socket, {
          type: "error",
          text: "Najpierw zaloguj Copilot przyciskiem „Zaloguj Copilot przez GitHub”."
        });
      }
      const repo = sessionRepos.get(message.repoId);
      if (!repo) return safeSend(socket, { type: "error", text: "Najpierw sklonuj repozytorium." });
      if (typeof message.prompt !== "string" || !message.prompt.trim() || message.prompt.length > MAX_PROMPT_LENGTH) {
        return safeSend(socket, { type: "error", text: `Polecenie musi mieć od 1 do ${MAX_PROMPT_LENGTH} znaków.` });
      }

      commandRunning = true;
      safeSend(socket, { type: "busy", busy: true });
      const env = copilotEnvironment();
      safeSend(socket, { type: "log", text: "\nUruchamiam Copilot CLI...\n" });
      try {
        await runCommand(
          socket,
          process.execPath,
          [
            COPILOT_ENTRY,
            "--prompt",
            message.prompt.trim(),
            "--allow-all-tools",
            "--no-ask-user",
            "--no-color",
            "--no-auto-update"
          ],
          { cwd: repo.path, env },
          20 * 60 * 1000
        );
        safeSend(socket, { type: "log", text: "\nCopilot zakończył zadanie.\n" });
      } catch (error) {
        safeSend(socket, { type: "error", text: `Copilot CLI: ${error.message}` });
      } finally {
        commandRunning = false;
        safeSend(socket, { type: "busy", busy: false });
      }
      return;
    }

    safeSend(socket, { type: "error", text: "Nieznany typ polecenia." });
  });
});

module.exports = server;
