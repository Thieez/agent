const { after, test } = require("node:test");
const assert = require("node:assert/strict");
const { once } = require("node:events");
const pty = require("node-pty");
const path = require("node:path");
const { WebSocket } = require("ws");
const { terminalEnvironment } = require("./child-environment");

process.env.PORT = "0";
process.env.APP_PASSWORD = "server-test-password-with-more-than-24";
process.env.GITHUB_TOKEN = "server-test-clone-token";
delete process.env.COPILOT_GITHUB_TOKEN;

const server = require("./server");

after(async () => {
  if (server.listening) await new Promise((resolve) => server.close(resolve));
});

test("terminal receives only its selected Copilot token and can find the CLI", () => {
  const environment = terminalEnvironment("selected-copilot-token", {
    APP_PASSWORD: "application-secret",
    GITHUB_TOKEN: "clone-token",
    GITHUB_TOKEN_WORK: "other-account-token",
    GH_TOKEN: "legacy-token",
    COPILOT_GITHUB_TOKEN: "default-copilot-token",
    COPILOT_HOME: "copilot-home",
    PATH: "existing-path"
  });

  assert.equal(environment.COPILOT_GITHUB_TOKEN, "selected-copilot-token");
  assert.equal(environment.GITHUB_TOKEN, undefined);
  assert.equal(environment.GITHUB_TOKEN_WORK, undefined);
  assert.equal(environment.GH_TOKEN, undefined);
  assert.equal(environment.APP_PASSWORD, undefined);
  assert.equal(environment.PATH.split(path.delimiter)[0], path.join(__dirname, "node_modules", ".bin"));
  assert.equal(environment.PATH.endsWith(`existing-path`), true);
});

test("terminal PTY runs interactive shell commands", {
  skip: process.platform === "win32" && "ConPTY process cleanup requires a Windows console unavailable in the test host."
}, async () => {
  const shell = process.platform === "win32"
    ? (process.env.COMSPEC || "cmd.exe")
    : (process.env.SHELL || "/bin/sh");
  const terminal = pty.spawn(shell, process.platform === "win32" ? [] : ["-i"], {
    name: "xterm-256color",
    cols: 80,
    rows: 24,
    env: { ...process.env, TERM: "xterm-256color" }
  });
  const marker = `pty-ready-${Date.now()}`;
  let output = "";
  const receivedOutput = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Timed out waiting for PTY output.")), 5000);
    terminal.onData((text) => {
      output += text;
      if (output.includes(marker)) {
        clearTimeout(timeout);
        resolve();
      }
    });
    terminal.onExit(() => {
      clearTimeout(timeout);
      reject(new Error("PTY shell exited before returning command output."));
    });
  });

  try {
    terminal.write(process.platform === "win32"
      ? `echo ${marker}\r`
      : `printf '${marker}\\n'\n`);
    await receivedOutput;
    assert.match(output, new RegExp(marker));
  } finally {
    terminal.kill();
  }
});

test("credential status verifies environment token scopes without exposing the token", async () => {
  if (!server.listening) await once(server, "listening");
  const origin = `http://127.0.0.1:${server.address().port}`;
  const login = await fetch(`${origin}/api/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ password: process.env.APP_PASSWORD })
  });
  assert.equal(login.status, 200);
  const cookie = login.headers.get("set-cookie").split(";")[0];
  const originalFetch = global.fetch;
  global.fetch = async (url, options) => {
    if (url !== "https://api.github.com/user") {
      return new Response("[]", { status: 200 });
    }
    assert.equal(url, "https://api.github.com/user");
    assert.equal(options.headers.Authorization, `Bearer ${process.env.GITHUB_TOKEN}`);
    return new Response(JSON.stringify({ login: "test-user" }), {
      status: 200,
      headers: { "x-oauth-scopes": "repo, read:org" }
    });
  };

  try {
    const response = await originalFetch(`${origin}/api/credentials`, {
      headers: { Cookie: cookie }
    });
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.equal(result.credentials[0].status, "valid");
    assert.equal(result.credentials[0].login, "test-user");
    assert.deepEqual(
      result.credentials[0].permissions.map((permission) => permission.name),
      ["repo", "read:org"]
    );
    assert.equal(JSON.stringify(result).includes(process.env.GITHUB_TOKEN), false);
  } finally {
    global.fetch = originalFetch;
  }
});

test("multiple environment tokens list their own accounts and repositories", async () => {
  if (!server.listening) await once(server, "listening");
  const origin = `http://127.0.0.1:${server.address().port}`;
  const login = await fetch(`${origin}/api/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ password: process.env.APP_PASSWORD })
  });
  const cookie = login.headers.get("set-cookie").split(";")[0];
  process.env.GITHUB_TOKEN_WORK = "server-test-work-token";
  const originalFetch = global.fetch;
  global.fetch = async (url, options) => {
    const isWorkToken = options.headers.Authorization.endsWith("-work-token");
    if (url === "https://api.github.com/user") {
      return new Response(JSON.stringify({ login: isWorkToken ? "work-user" : "test-user" }), {
        status: 200,
        headers: isWorkToken ? {} : { "x-oauth-scopes": "repo, read:org" }
      });
    }
    return new Response(JSON.stringify([{
      full_name: isWorkToken ? "work-user/work-repo" : "test-user/personal-repo",
      private: isWorkToken,
      permissions: { pull: true, push: isWorkToken }
    }]), { status: 200 });
  };

  try {
    const response = await originalFetch(`${origin}/api/credentials`, {
      headers: { Cookie: cookie }
    });
    const { credentials } = await response.json();
    assert.equal(response.status, 200);
    assert.deepEqual(credentials.map((credential) => credential.name), [
      "GITHUB_TOKEN",
      "GITHUB_TOKEN_WORK"
    ]);
    assert.deepEqual(credentials.map((credential) => credential.login), ["test-user", "work-user"]);
    assert.deepEqual(credentials.map((credential) => credential.repos[0].fullName), [
      "test-user/personal-repo",
      "work-user/work-repo"
    ]);
    assert.equal(JSON.stringify(credentials).includes(process.env.GITHUB_TOKEN), false);
    assert.equal(JSON.stringify(credentials).includes(process.env.GITHUB_TOKEN_WORK), false);
  } finally {
    global.fetch = originalFetch;
    delete process.env.GITHUB_TOKEN_WORK;
  }
});

test("terminal WebSocket supports app-root sessions and rejects unknown repositories", {
  skip: process.platform === "win32" && "ConPTY process cleanup requires a Windows console unavailable in the test host."
}, async () => {
  if (!server.listening) await once(server, "listening");
  const origin = `http://127.0.0.1:${server.address().port}`;
  const login = await fetch(`${origin}/api/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ password: process.env.APP_PASSWORD })
  });
  assert.equal(login.status, 200);
  const cookie = login.headers.get("set-cookie").split(";")[0];
  const socket = new WebSocket(`${origin.replace("http", "ws")}/ws`, {
    headers: { Cookie: cookie, Origin: origin }
  });
  const queued = [];
  const waiters = [];
  socket.on("message", (data) => {
    const message = JSON.parse(data.toString());
    const resolve = waiters.shift();
    if (resolve) resolve(message);
    else queued.push(message);
  });
  const nextMessage = () => queued.length
    ? Promise.resolve(queued.shift())
    : new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error("Timed out waiting for WebSocket message.")), 5000);
        waiters.push((message) => {
          clearTimeout(timeout);
          resolve(message);
        });
      });

  try {
    await once(socket, "open");
    const ready = await nextMessage();
    assert.equal(ready.type, "ready");
    assert.deepEqual(ready.repos, []);
    assert.deepEqual(ready.terminals, []);

    socket.send(JSON.stringify({ type: "terminal-create", repoId: "not-cloned" }));
    const error = await nextMessage();
    assert.equal(error.type, "error");
    assert.match(error.text, /Wybierz sklonowane repozytorium albo katalog aplikacji/);

    socket.send(JSON.stringify({ type: "terminal-create", repoId: "__app_root__" }));
    const created = await nextMessage();
    assert.equal(created.type, "terminal-created");
    assert.equal(created.terminal.repoId, null);
    assert.equal(created.terminal.repoName, "Katalog aplikacji");

    socket.send(JSON.stringify({ type: "terminal-close", terminalId: created.terminal.id }));
    const closed = await nextMessage();
    assert.equal(closed.type, "terminal-closed");
    assert.equal(closed.terminalId, created.terminal.id);

    socket.send(JSON.stringify({ type: "clone", tokenId: "GITHUB_TOKEN_MISSING", repo: "owner/repo" }));
    const cloneError = await nextMessage();
    assert.equal(cloneError.type, "error");
    assert.match(cloneError.text, /Nie znaleziono tokenu środowiskowego/);
  } finally {
    if (socket.readyState === WebSocket.OPEN) {
      const closed = once(socket, "close");
      socket.close();
      await closed;
    }
  }
});

test("xterm browser assets are served locally", async () => {
  if (!server.listening) await once(server, "listening");
  const origin = `http://127.0.0.1:${server.address().port}`;
  for (const asset of ["/vendor/xterm.js", "/vendor/xterm.css", "/vendor/addon-fit.js"]) {
    const response = await fetch(`${origin}${asset}`);
    assert.equal(response.status, 200, `${asset} should load`);
  }
});
