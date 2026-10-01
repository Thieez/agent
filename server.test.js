const { after, test } = require("node:test");
const assert = require("node:assert/strict");
const { once } = require("node:events");
const { existsSync, mkdtempSync, rmSync, writeFileSync } = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { WebSocket } = require("ws");
const pty = require("node-pty");
const { terminalEnvironment } = require("./child-environment");

process.env.PORT = "0";
process.env.APP_PASSWORD = "server-test-password-with-more-than-24";
const gupRoot = mkdtempSync(path.join(os.tmpdir(), "repo-agent-gup-test-"));
writeFileSync(path.join(gupRoot, "gup.ps1"), "");
process.env.GUP_ROOT = gupRoot;
const server = require("./server");
const terminalDependencies = require("./config.json").terminalDependencies;

after(async () => {
  if (server.listening) await new Promise((resolve) => server.close(resolve));
  rmSync(gupRoot, { recursive: true, force: true });
});

test("gup terminal keeps gup credentials but never receives the app password", () => {
  const environment = terminalEnvironment({
    APP_PASSWORD: "application-secret",
    GITHUB_TOKEN: "gup-token",
    GITHUB_TOKEN_WORK: "work-token",
    GITHUB_TOKEN_1: "token GITHUB_TOKEN_WORK=github_pat_invalid\n",
    PATH: "existing-path"
  });
  assert.equal(environment.APP_PASSWORD, undefined);
  assert.equal(environment.GITHUB_TOKEN, "gup-token");
  assert.equal(environment.GITHUB_TOKEN_WORK, "work-token");
  assert.equal(environment.GITHUB_TOKEN_1, undefined);
  assert.equal(environment.PATH.split(path.delimiter)[0], path.join(__dirname, "node_modules", ".bin"));
  assert.equal(environment.PATH.endsWith("existing-path"), true);
});

test("PowerShell is installed after npm-based terminal dependencies", () => {
  const dependencyNames = terminalDependencies.map((dependency) => dependency.name);
  assert.equal(dependencyNames.at(-1), "PowerShell");
  assert.ok(dependencyNames.indexOf("GitHub Copilot CLI") < dependencyNames.indexOf("PowerShell"));
});

test("login protects the terminal page and GitHub-specific API is gone", async () => {
  if (!server.listening) await once(server, "listening");
  const origin = `http://127.0.0.1:${server.address().port}`;
  const rejected = await fetch(`${origin}/api/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ password: "wrong-password" })
  });
  assert.equal(rejected.status, 401);

  const login = await fetch(`${origin}/api/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ password: process.env.APP_PASSWORD })
  });
  assert.equal(login.status, 200);
  const cookie = login.headers.get("set-cookie").split(";")[0];
  assert.equal((await fetch(`${origin}/api/session`, { headers: { Cookie: cookie } })).status, 200);
  assert.equal((await fetch(`${origin}/api/credentials`, { headers: { Cookie: cookie } })).status, 404);
  assert.equal((await fetch(origin)).status, 200);
});

test("terminal WebSocket creates gup terminals and rejects removed clone commands", async () => {
  if (!server.listening) await once(server, "listening");
  const origin = `http://127.0.0.1:${server.address().port}`;
  const login = await fetch(`${origin}/api/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ password: process.env.APP_PASSWORD })
  });
  const cookie = login.headers.get("set-cookie").split(";")[0];
  const socket = new WebSocket(`${origin.replace("http", "ws")}/ws`, {
    headers: { Cookie: cookie, Origin: origin }
  });
  const queued = [];
  const waiters = [];
  const nextMessage = () => queued.length
    ? Promise.resolve(queued.shift())
    : new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error("Timed out waiting for WebSocket message.")), 5000);
        waiters.push((message) => {
          clearTimeout(timeout);
          resolve(message);
        });
      });
  socket.on("message", (data) => {
    const message = JSON.parse(data.toString());
    const resolve = waiters.shift();
    if (resolve) resolve(message);
    else queued.push(message);
  });

  const originalSpawn = pty.spawn;
  let spawnOptions;
  pty.spawn = (shell, args, options) => {
    spawnOptions = { shell, args, options };
    return {
      onData() {},
      onExit() {},
      write() {},
      resize() {},
      kill() {}
    };
  };

  try {
    await once(socket, "open");
    const ready = await nextMessage();
    assert.equal(ready.type, "ready");
    assert.deepEqual(ready.terminals, []);

    socket.send(JSON.stringify({ type: "terminal-create" }));
    const created = await nextMessage();
    assert.equal(created.type, "terminal-created");
    assert.match(created.terminal.name, /^gup \(\d+\)$/);
    assert.equal(spawnOptions.options.cwd, gupRoot);
    assert.equal(existsSync(path.join(gupRoot, "repos")), true);
    assert.equal(spawnOptions.shell, process.platform === "win32"
      ? "powershell.exe"
      : path.join(__dirname, "node_modules", ".bin", "pwsh"));
    assert.equal(spawnOptions.args[0], "-NoLogo");
    assert.equal(spawnOptions.args[1], "-NoExit");
    assert.match(spawnOptions.args[3], /gup\.ps1/);
    assert.equal(spawnOptions.options.env.APP_PASSWORD, undefined);

    socket.send(JSON.stringify({ type: "clone", repo: "owner/repo" }));
    const removedCommand = await nextMessage();
    assert.equal(removedCommand.type, "error");
    assert.equal(removedCommand.text, "Nieznany typ polecenia.");

    socket.send(JSON.stringify({ type: "terminal-close", terminalId: created.terminal.id }));
    const closed = await nextMessage();
    assert.equal(closed.type, "terminal-closed");
    assert.equal(closed.terminalId, created.terminal.id);
  } finally {
    pty.spawn = originalSpawn;
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
