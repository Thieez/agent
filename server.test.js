const { after, test } = require("node:test");
const assert = require("node:assert/strict");
const { once } = require("node:events");
const pty = require("node-pty");
const { WebSocket } = require("ws");

process.env.PORT = "0";
process.env.APP_PASSWORD = "server-test-password-with-more-than-24";
process.env.GITHUB_TOKEN = "server-test-clone-token";
delete process.env.COPILOT_GITHUB_TOKEN;

const server = require("./server");

after(async () => {
  if (server.listening) await new Promise((resolve) => server.close(resolve));
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

test("terminal WebSocket requires an available cloned repository", async () => {
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
    assert.match(error.text, /Najpierw sklonuj i wybierz repozytorium/);
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
