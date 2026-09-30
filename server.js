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
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const MAX_REPOSITORIES_PER_SESSION = 3;
const MAX_TOKENS = 10;
const MAX_CHATS_PER_SESSION = 10;
const MAX_ACTIVE_COPILOT_RUNS = 4;
const MAX_PROMPT_LENGTH = 8000;
const MAX_CHAT_OUTPUT_LENGTH = 100000;
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
const chats = new Map();
const sessionSockets = new Map();
const copilotTokens = new Map();
const activeCopilotRuns = new Set();
let cloneRunning = false;

if (process.env.COPILOT_GITHUB_TOKEN) {
  copilotTokens.set(crypto.randomUUID(), {
    label: "Token z konfiguracji Rendera",
    value: process.env.COPILOT_GITHUB_TOKEN
  });
}

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
  chats.delete(key);
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

function publicTokens() {
  return [...copilotTokens.entries()].map(([id, token]) => ({
    id,
    label: token.label,
    masked: `••••${token.value.slice(-4)}`
  }));
}

function publicChat(chat) {
  return {
    id: chat.id,
    tokenId: chat.tokenId,
    tokenLabel: copilotTokens.get(chat.tokenId)?.label || "Token usunięty",
    repoId: chat.repoId,
    repoName: chat.repoName,
    output: chat.output,
    busy: chat.busy
  };
}

function appendChatOutput(chat, text) {
  chat.output += text;
  if (chat.output.length > MAX_CHAT_OUTPUT_LENGTH) {
    chat.output = `[starsze logi ucięte]\n${chat.output.slice(-MAX_CHAT_OUTPUT_LENGTH)}`;
  }
  sendToSession(chat.ownerId, { type: "chat-log", chatId: chat.id, text });
}

function setChatBusy(chat, busy) {
  chat.busy = busy;
  sendToSession(chat.ownerId, { type: "chat-state", chat: publicChat(chat) });
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
  env.COPILOT_HOME = COPILOT_HOME;
  return env;
}

function copilotEnvironment(token) {
  const env = childEnvironment();
  env.COPILOT_GITHUB_TOKEN = token;
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
  let sessionChats = chats.get(socket.session.id);
  if (!sessionChats) {
    sessionChats = new Map();
    chats.set(socket.session.id, sessionChats);
  }
  let sockets = sessionSockets.get(socket.session.id);
  if (!sockets) {
    sockets = new Set();
    sessionSockets.set(socket.session.id, sockets);
  }
  sockets.add(socket);

  safeSend(socket, {
    type: "ready",
    tokens: publicTokens(),
    repos: [...sessionRepos.entries()].map(([id, repo]) => ({ id, name: repo.name })),
    chats: [...sessionChats.values()].map(publicChat)
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

    if (message.type === "token-save") {
      const tokenId = typeof message.tokenId === "string" ? message.tokenId : null;
      const existing = tokenId ? copilotTokens.get(tokenId) : null;
      if (tokenId && !existing) {
        return safeSend(socket, { type: "error", text: "Nie znaleziono tokenu do edycji." });
      }
      const label = typeof message.label === "string" ? message.label.trim() : "";
      const token = typeof message.token === "string" ? message.token.trim() : "";
      if (
        !label ||
        label.length > 40 ||
        (!existing && !token) ||
        (token && (token.length > 4096 || !/^(?:gho_|github_pat_|ghu_)[A-Za-z0-9_-]+$/.test(token)))
      ) {
        return safeSend(socket, {
          type: "error",
          text: "Podaj nazwę do 40 znaków i poprawny token OAuth (gho_), fine-grained PAT (github_pat_) lub GitHub App (ghu_)."
        });
      }
      if (!existing && copilotTokens.size >= MAX_TOKENS) {
        return safeSend(socket, { type: "error", text: `Można dodać maksymalnie ${MAX_TOKENS} tokenów.` });
      }
      const id = tokenId || crypto.randomUUID();
      copilotTokens.set(id, {
        label,
        value: token || existing.value
      });
      broadcast({ type: "tokens", tokens: publicTokens() });
      return safeSend(socket, { type: "token-saved", tokenId: id });
    }

    if (message.type === "token-delete") {
      const tokenId = typeof message.tokenId === "string" ? message.tokenId : "";
      if (!copilotTokens.has(tokenId)) {
        return safeSend(socket, { type: "error", text: "Nie znaleziono tokenu do usunięcia." });
      }
      const linkedChats = [...chats.entries()].flatMap(([ownerId, ownerChats]) =>
        [...ownerChats.values()]
          .filter((chat) => chat.tokenId === tokenId)
          .map((chat) => ({ ownerId, ownerChats, chat }))
      );
      if (linkedChats.some(({ chat }) => chat.busy)) {
        return safeSend(socket, { type: "error", text: "Nie można usunąć tokenu, gdy przypisany do niego chat działa." });
      }
      for (const { ownerId, ownerChats, chat } of linkedChats) {
        ownerChats.delete(chat.id);
        sendToSession(ownerId, { type: "chat-deleted", chatId: chat.id });
      }
      copilotTokens.delete(tokenId);
      broadcast({ type: "tokens", tokens: publicTokens() });
      return;
    }

    if (message.type === "chat-create") {
      const tokenId = typeof message.tokenId === "string" ? message.tokenId : "";
      const repoId = typeof message.repoId === "string" ? message.repoId : "";
      const token = copilotTokens.get(tokenId);
      const repo = sessionRepos.get(repoId);
      if (!token) return safeSend(socket, { type: "error", text: "Najpierw dodaj token Copilot." });
      if (!repo) return safeSend(socket, { type: "error", text: "Najpierw sklonuj i wybierz repozytorium." });
      if (sessionChats.size >= MAX_CHATS_PER_SESSION) {
        return safeSend(socket, { type: "error", text: `Można utworzyć maksymalnie ${MAX_CHATS_PER_SESSION} chatów.` });
      }
      const chat = {
        id: crypto.randomUUID(),
        cliSessionId: crypto.randomUUID(),
        ownerId: socket.session.id,
        tokenId,
        repoId,
        repoName: repo.name,
        output: "",
        busy: false
      };
      sessionChats.set(chat.id, chat);
      return safeSend(socket, { type: "chat-created", chat: publicChat(chat) });
    }

    if (message.type === "chat-delete") {
      const chatId = typeof message.chatId === "string" ? message.chatId : "";
      const chat = sessionChats.get(chatId);
      if (!chat) return safeSend(socket, { type: "error", text: "Nie znaleziono chatu." });
      if (chat.busy) return safeSend(socket, { type: "error", text: "Nie można zamknąć chatu podczas wykonywania zadania." });
      sessionChats.delete(chatId);
      return safeSend(socket, { type: "chat-deleted", chatId });
    }

    if (message.type === "chat-prompt") {
      const chatId = typeof message.chatId === "string" ? message.chatId : "";
      const chat = sessionChats.get(chatId);
      if (!chat) return safeSend(socket, { type: "error", text: "Nie znaleziono chatu." });
      if (chat.busy) return safeSend(socket, { type: "error", text: "Ten chat już działa." });
      const token = copilotTokens.get(chat.tokenId);
      if (!token) return safeSend(socket, { type: "error", text: "Token przypisany do tego chatu został usunięty." });
      const repo = sessionRepos.get(chat.repoId);
      if (!repo) return safeSend(socket, { type: "error", text: "Repozytorium tego chatu nie jest już dostępne." });
      if (activeCopilotRuns.size >= MAX_ACTIVE_COPILOT_RUNS) {
        return safeSend(socket, { type: "error", text: `Limit równoległych zadań Copilot (${MAX_ACTIVE_COPILOT_RUNS}) został osiągnięty.` });
      }
      if ([...activeCopilotRuns].some((active) => active.repoPath === repo.path)) {
        return safeSend(socket, { type: "error", text: "Inny chat już pracuje w tym repozytorium. Uruchom go na innym repozytorium, aby uniknąć konfliktów zmian." });
      }
      if (typeof message.prompt !== "string" || !message.prompt.trim() || message.prompt.length > MAX_PROMPT_LENGTH) {
        return safeSend(socket, { type: "error", text: `Polecenie musi mieć od 1 do ${MAX_PROMPT_LENGTH} znaków.` });
      }

      const activeRun = { chatId: chat.id, repoPath: repo.path };
      activeCopilotRuns.add(activeRun);
      setChatBusy(chat, true);
      appendChatOutput(chat, `\n> ${message.prompt.trim()}\n\nUruchamiam Copilot CLI...\n`);
      try {
        await mkdir(COPILOT_HOME, { recursive: true });
        await runCommand(
          process.execPath,
          [
            COPILOT_ENTRY,
            "--prompt",
            message.prompt.trim(),
            "--session-id",
            chat.cliSessionId,
            "--secret-env-vars=COPILOT_GITHUB_TOKEN",
            "--allow-all-tools",
            "--no-ask-user",
            "--no-color",
            "--no-auto-update"
          ],
          { cwd: repo.path, env: copilotEnvironment(token.value) },
          20 * 60 * 1000,
          (text) => appendChatOutput(chat, text)
        );
        appendChatOutput(chat, "\nCopilot zakończył zadanie.\n");
      } catch (error) {
        appendChatOutput(chat, `\nBŁĄD Copilot CLI: ${error.message}\n`);
      } finally {
        activeCopilotRuns.delete(activeRun);
        setChatBusy(chat, false);
      }
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
