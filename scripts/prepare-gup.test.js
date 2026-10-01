const { test } = require("node:test");
const assert = require("node:assert/strict");
const { mkdtemp, mkdir, readFile, rm, stat, writeFile } = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const {
  copyAgentEnvironment,
  findGitHubToken,
  gitEnvironment,
  parseEnvironmentFile,
  verifyGitHubAccess
} = require("./prepare-gup");

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

test("reports missing private-repository access without disclosing credentials", async () => {
  const secret = "inaccessible-token";
  await assert.rejects(
    verifyGitHubAccess(secret, async (url, options) => {
      assert.equal(url, "https://api.github.com/repos/Tomasz-Gziut/gup");
      assert.equal(options.headers.Authorization, `Bearer ${secret}`);
      return new Response(JSON.stringify({ message: "Not Found" }), { status: 404 });
    }),
    (error) => {
      assert.match(error.message, /GITHUB_TOKEN/);
      assert.match(error.message, /Contents: read/);
      assert.equal(error.message.includes(secret), false);
      return true;
    }
  );
});

test("accepts a token with access to the expected private repository", async () => {
  await verifyGitHubAccess("authorized-token", async () => new Response(
    JSON.stringify({ full_name: "Tomasz-Gziut/gup" }),
    { status: 200 }
  ));
});

test("reads GitHub credentials and adds authentication without exposing the token", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "gup-agent-token-test-"));
  const secret = "private-build-token";
  await writeFile(
    path.join(root, ".env"),
    `GITHUB_TOKEN_WORK='work-file-token'\nGITHUB_TOKEN=${secret}\n`
  );

  try {
    assert.deepEqual(parseEnvironmentFile("# comment\nGITHUB_TOKEN='quoted'\nOTHER=value"), {
      GITHUB_TOKEN: "quoted"
    });
    assert.equal(await findGitHubToken(root, {
      GITHUB_TOKEN: "runtime-token",
      GITHUB_TOKEN_WORK: "another-runtime-token"
    }), "runtime-token");
    assert.equal(await findGitHubToken(root, { GITHUB_TOKEN: "" }), secret);

    const environment = gitEnvironment(secret, { PATH: "existing-path" });
    assert.equal(environment.GIT_CONFIG_KEY_0, "http.https://github.com/.extraheader");
    assert.equal(
      Buffer.from(environment.GIT_CONFIG_VALUE_0.split("basic ")[1], "base64").toString(),
      `x-access-token:${secret}`
    );
    assert.equal(JSON.stringify(environment).includes(secret), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
