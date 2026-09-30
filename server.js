const crypto = require("node:crypto");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { mkdtemp, rm } = require("node:fs/promises");
const express = require("express");
const { WebSocketServer, WebSocket } = require("ws");
const pty = require("node-pty");
const { parseRepository } = require("./repository");
const { childEnvironment, terminalEnvironment } = require("./child-environment");

const PORT = Number(process.env.PORT || 3000);
const APP_PASSWORD = process.env.APP_PASSWORD;
const APP_ROOT_TERMINAL_ID = "__app_root__";
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const MAX_REPOSITORIES_PER_SESSION = 3;
const MAX_TERMINALS_PER_SESSION = 10;
const MAX_TERMINAL_OUTPUT_LENGTH = 100000;

if (!APP_PASSWORD || APP_PASSWORD.length < 24) {
  throw new Error("Set APP_PASSWORD (at least 24 characters) before starting the server.");
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
    copilotTokenName: terminal.copilotTokenName,
    output: terminal.output,
    exited: terminal.exited
  };
}

function githubTokenType(token) {
  if (token.startsWith("github_pat_")) return "Fine-grained PAT";
  if (token.startsWith("ghp_")) return "Personal access token (classic)";
  if (token.startsWith("gho_")) return "GitHub OAuth token";
  if (token.startsWith("ghu_")) return "GitHub App user token";
  return "Inny token GitHub";
}

function githubTokens() {
  return Object.entries(process.env)
    .filter(([name, value]) =>
      /^GITHUB_TOKEN(?:_[A-Z0-9_]+)?$/i.test(name) &&
      typeof value === "string" &&
      value.trim()
    )
    .sort(([left], [right]) => {
      if (left.toUpperCase() === "GITHUB_TOKEN") return -1;
      if (right.toUpperCase() === "GITHUB_TOKEN") return 1;
      return left.localeCompare(right);
    })
    .map(([name, value]) => ({ name, value: value.trim() }));
}

function githubApiHeaders(token) {
  return {
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${token}`,
    "X-GitHub-Api-Version": "2022-11-28"
  };
}

async function fetchGithubRepositories(token) {
  const repos = [];
  const baseUrl = "https://api.github.com/user/repos?affiliation=owner%2Ccollaborator%2Corganization_member&visibility=all&per_page=100&sort=full_name";
  let url = baseUrl;

  while (url) {
    const response = await fetch(url, {
      headers: githubApiHeaders(token),
      signal: AbortSignal.timeout(10000)
    });
    if (!response.ok) {
      return {
        repos,
        error: `GitHub nie udostępnił listy repozytoriów (HTTP ${response.status}).`
      };
    }
    const page = await response.json();
    if (!Array.isArray(page)) {
      return { repos, error: "GitHub zwrócił nieprawidłową listę repozytoriów." };
    }
    for (const repo of page) {
      if (typeof repo.full_name !== "string") continue;
      repos.push({
        fullName: repo.full_name,
        private: Boolean(repo.private),
        permissions: repo.permissions && typeof repo.permissions === "object"
          ? Object.entries(repo.permissions)
            .filter(([, allowed]) => allowed === true)
            .map(([permission]) => permission)
          : []
      });
    }
    const nextLink = (response.headers.get("link") || "")
      .split(",")
      .find((link) => /rel="next"/.test(link));
    const nextUrl = nextLink && nextLink.match(/<([^>]+)>/);
    url = nextUrl ? nextUrl[1] : null;
    if (url && new URL(url).origin !== "https://api.github.com") {
      return { repos, error: "GitHub zwrócił nieprawidłowy link paginacji." };
    }
  }

  return { repos, error: null };
}

function appendTerminalOutput(terminal, text) {
  terminal.output += text;
  if (terminal.output.length > MAX_TERMINAL_OUTPUT_LENGTH) {
    terminal.output = terminal.output.slice(-MAX_TERMINAL_OUTPUT_LENGTH);
  }
  sendToSession(terminal.ownerId, { type: "terminal-output", terminalId: terminal.id, text });
}

function runCommand(command, args, options, timeoutMs) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      ...options,
      stdio: "ignore",
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

    child.on("error", (error) => finish(error));
    child.on("close", (code) => {
      if (timedOut) finish(new Error("Przekroczono limit czasu polecenia."));
      else finish(null, code);
    });
  });
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

app.get("/api/credentials", async (req, res) => {
  if (!getSession(req)) return sendJson(res, 401, { error: "Zaloguj się ponownie." });
  const tokens = githubTokens();
  if (!tokens.length) {
    return sendJson(res, 200, {
      credentials: [],
      message: "Dodaj GITHUB_TOKEN lub GITHUB_TOKEN_NAZWA jako sekrety środowiskowe usługi Render."
    });
  }

  const scopeDescriptions = {
    "admin:org": "Może zarządzać organizacjami i ich zespołami.",
    "admin:org_hook": "Może zarządzać webhookami organizacji.",
    "admin:public_key": "Może zarządzać publicznymi kluczami SSH użytkownika.",
    "admin:repo_hook": "Może zarządzać webhookami repozytoriów.",
    delete_repo: "Może usuwać repozytoria.",
    gist: "Może tworzyć i zarządzać gistami.",
    notifications: "Może zarządzać powiadomieniami.",
    public_repo: "Odczyt i zapis publicznych repozytoriów.",
    "read:org": "Może odczytywać członkostwo, zespoły i dane organizacji.",
    "read:public_key": "Może odczytywać publiczne klucze SSH użytkownika.",
    "read:user": "Może odczytywać profil użytkownika.",
    repo: "Pełny dostęp do repozytoriów, w tym prywatnych.",
    "repo:invite": "Może zapraszać współpracowników do repozytoriów.",
    "repo:status": "Może odczytywać i zapisywać statusy commitów.",
    "user:email": "Może odczytywać adresy e-mail użytkownika.",
    "user:follow": "Może obserwować i przestawać obserwować użytkowników.",
    workflow: "Może zarządzać plikami workflow GitHub Actions.",
    "write:org": "Może zarządzać członkostwem i zespołami organizacji.",
    "write:public_key": "Może dodawać i usuwać publiczne klucze SSH użytkownika."
  };
  const credentials = await Promise.all(tokens.map(async ({ name, value }) => {
    try {
      const response = await fetch("https://api.github.com/user", {
        headers: githubApiHeaders(value),
        signal: AbortSignal.timeout(10000)
      });
      const scopes = (response.headers.get("x-oauth-scopes") || "")
        .split(",")
        .map((scope) => scope.trim())
        .filter(Boolean);
      const status = response.ok ? "valid" : response.status === 401 ? "invalid" : "unavailable";
      let login = null;
      let repoList = {
        repos: [],
        error: response.ok ? null : "Repozytoria wymagają poprawnego tokenu GitHub."
      };
      if (response.ok) {
        const user = await response.json();
        login = typeof user.login === "string" ? user.login : null;
        repoList = await fetchGithubRepositories(value);
      }

      return {
        name,
        purpose: "Klonowanie repozytoriów GitHub",
        status,
        login,
        tokenType: githubTokenType(value),
        permissions: scopes.map((scope) => ({
          name: scope,
          description: scopeDescriptions[scope] || "Zakres OAuth przyznany temu tokenowi."
        })),
        permissionMessage: !response.ok
          ? `GitHub nie potwierdził tokenu (HTTP ${response.status}).`
          : scopes.length
            ? "Zakresy OAuth zwrócone przez GitHub."
            : "GitHub nie udostępnia zakresów OAuth dla tego typu tokenu. Szczegółowe uprawnienia sprawdź w ustawieniach tokenu.",
        repos: repoList.repos,
        reposMessage: repoList.error
      };
    } catch (error) {
      console.error(`Failed to verify GitHub token ${name}: ${error.message}`);
      return {
        name,
        purpose: "Klonowanie repozytoriów GitHub",
        status: "unavailable",
        tokenType: githubTokenType(value),
        permissions: [],
        permissionMessage: "Nie udało się teraz połączyć z GitHub, aby zweryfikować token i jego zakresy.",
        repos: [],
        reposMessage: "Nie udało się pobrać repozytoriów z GitHub."
      };
    }
  }));

  return sendJson(res, 200, { credentials });
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
      const copilotTokenName = typeof message.copilotTokenName === "string"
        ? message.copilotTokenName
        : "";
      const copilotToken = copilotTokenName
        ? githubTokens().find(({ name }) => name === copilotTokenName)
        : null;
      const isAppRoot = repoId === APP_ROOT_TERMINAL_ID;
      const repo = isAppRoot ? null : sessionRepos.get(repoId);
      if (!isAppRoot && !repo) {
        return safeSend(socket, { type: "error", text: "Wybierz sklonowane repozytorium albo katalog aplikacji." });
      }
      if (copilotTokenName && !copilotToken) {
        return safeSend(socket, { type: "error", text: "Nie znaleziono wybranego tokenu Copilot w konfiguracji środowiska." });
      }
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
          cwd: isAppRoot ? __dirname : repo.path,
          env: { ...terminalEnvironment(copilotToken && copilotToken.value), TERM: "xterm-256color" }
        });
        terminal = {
          id: crypto.randomUUID(),
          ownerId: socket.session.id,
          repoId: isAppRoot ? null : repoId,
          repoName: isAppRoot ? "Katalog aplikacji" : repo.name,
          copilotTokenName: copilotToken ? copilotToken.name : null,
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
      const tokenId = typeof message.tokenId === "string" ? message.tokenId : "";
      const token = githubTokens().find(({ name: envName }) => envName === tokenId);
      if (!token) {
        return safeSend(socket, { type: "error", text: "Nie znaleziono tokenu środowiskowego dla tego repozytorium." });
      }
      if (cloneRunning) {
        return safeSend(socket, { type: "error", text: "Inne repozytorium jest już klonowane." });
      }
      if (sessionRepos.size >= MAX_REPOSITORIES_PER_SESSION) {
        return safeSend(socket, { type: "error", text: "Limit repozytoriów w tej sesji został osiągnięty." });
      }

      cloneRunning = true;
      broadcast({ type: "clone-state", busy: true });
      let workspace;
      try {
        const [owner, repoName] = name.split("/");
        const accessResponse = await fetch(
          `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repoName)}`,
          {
            headers: githubApiHeaders(token.value),
            signal: AbortSignal.timeout(10000)
          }
        );
        if (!accessResponse.ok) {
          throw new Error(`Token ${token.name} nie ma dostępu do ${name} (HTTP ${accessResponse.status}).`);
        }
        const repo = await accessResponse.json();
        if (typeof repo.full_name !== "string") {
          throw new Error("GitHub nie zwrócił prawidłowej nazwy repozytorium.");
        }
        const cloneName = repo.full_name;
        workspace = await mkdtemp(path.join(os.tmpdir(), "copilot-repo-"));
        const id = crypto.randomUUID();
        const auth = Buffer.from(`x-access-token:${token.value}`).toString("base64");
        const env = childEnvironment();
        env.GIT_TERMINAL_PROMPT = "0";
        env.GIT_CONFIG_COUNT = "1";
        env.GIT_CONFIG_KEY_0 = "http.extraheader";
        env.GIT_CONFIG_VALUE_0 = `AUTHORIZATION: basic ${auth}`;
        await runCommand(
          "git",
          ["clone", "--", `https://github.com/${cloneName}.git`, workspace],
          { cwd: os.tmpdir(), env },
          10 * 60 * 1000
        );
        sessionRepos.set(id, { name: cloneName, path: workspace });
        safeSend(socket, { type: "repo", id, name: cloneName });
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
