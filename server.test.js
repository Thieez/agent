const { after, test } = require("node:test");
const assert = require("node:assert/strict");
const { once } = require("node:events");

process.env.PORT = "0";
process.env.APP_PASSWORD = "server-test-password-with-more-than-24";
process.env.GITHUB_TOKEN = "server-test-clone-token";
delete process.env.COPILOT_GITHUB_TOKEN;

const server = require("./server");
const { WebSocket } = require("ws");

after(async () => {
  if (server.listening) await new Promise((resolve) => server.close(resolve));
});

test("Copilot tokens can be added, edited, and removed without exposing their values", async () => {
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
  const received = [];
  socket.on("message", (data) => {
    const message = JSON.parse(data.toString());
    received.push(message);
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
    assert.deepEqual((await nextMessage()).tokens, []);

    socket.send(JSON.stringify({ type: "token-save", label: "Test", token: "ghp_not-supported" }));
    assert.equal((await nextMessage()).type, "error");

    const token = `github_pat_${"a".repeat(32)}`;
    socket.send(JSON.stringify({ type: "token-save", label: "Work account", token }));
    const listed = await nextMessage();
    assert.equal(listed.type, "tokens");
    assert.equal(listed.tokens.length, 1);
    assert.equal(listed.tokens[0].label, "Work account");
    assert.equal(listed.tokens[0].masked.endsWith("aaaa"), true);
    const created = await nextMessage();
    assert.equal(created.type, "token-saved");
    const tokenId = created.tokenId;

    socket.send(JSON.stringify({ type: "token-save", tokenId, label: "Updated account", token: "" }));
    const edited = await nextMessage();
    assert.equal(edited.type, "tokens");
    assert.equal(edited.tokens[0].label, "Updated account");
    assert.equal((await nextMessage()).type, "token-saved");

    socket.send(JSON.stringify({ type: "token-delete", tokenId }));
    const removed = await nextMessage();
    assert.equal(removed.type, "tokens");
    assert.deepEqual(removed.tokens, []);
    assert.equal(received.some((message) => JSON.stringify(message).includes(token)), false);
  } finally {
    if (socket.readyState === WebSocket.OPEN) {
      const closed = once(socket, "close");
      socket.close();
      await closed;
    }
  }
});
