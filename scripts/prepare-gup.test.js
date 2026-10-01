const { test } = require("node:test");
const assert = require("node:assert/strict");
const { mkdtemp, mkdir, readFile, rm, stat, writeFile } = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { copyAgentEnvironment } = require("./prepare-gup");

test("copies the agent .env to gup and removes stale copies", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "gup-agent-env-test-"));
  const agentRoot = path.join(root, "agent");
  const gupRoot = path.join(root, "gup");
  const envContent = "GITHUB_TOKEN=test-build-token\n";
  await mkdir(agentRoot);
  await mkdir(gupRoot);

  try {
    await writeFile(path.join(agentRoot, ".env"), envContent);
    assert.equal(await copyAgentEnvironment(agentRoot, gupRoot), true);
    assert.equal(await readFile(path.join(gupRoot, ".env"), "utf8"), envContent);
    if (process.platform !== "win32") {
      assert.equal((await stat(path.join(gupRoot, ".env"))).mode & 0o777, 0o600);
    }

    await rm(path.join(agentRoot, ".env"));
    assert.equal(await copyAgentEnvironment(agentRoot, gupRoot), false);
    await assert.rejects(readFile(path.join(gupRoot, ".env")));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
