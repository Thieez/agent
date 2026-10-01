const { spawnSync } = require("node:child_process");
const { chmod, copyFile, access, readFile, rm } = require("node:fs/promises");
const path = require("node:path");

const agentRoot = path.resolve(__dirname, "..");
const gupRoot = path.join(agentRoot, "gup");
const gupRepository = "https://github.com/Tomasz-Gziut/gup.git";
const gupApiEndpoint = "https://api.github.com/repos/Tomasz-Gziut/gup";

async function pathExists(target) {
  try {
    await access(target);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

function parseEnvironmentFile(content) {
  const values = {};
  for (const line of content.split(/\r?\n/)) {
    const match = line.match(/^\s*(GITHUB_TOKEN(?:_[A-Za-z0-9_-]+)?)\s*=\s*(.*?)\s*$/);
    if (!match) continue;
    let value = match[2];
    if (value.length >= 2 &&
        ((value[0] === '"' && value.at(-1) === '"') ||
         (value[0] === "'" && value.at(-1) === "'"))) {
      value = value.slice(1, -1);
    }
    if (value.trim()) values[match[1]] = value;
  }
  return values;
}

async function findGitHubToken(root, environment = process.env) {
  const filePath = path.join(root, ".env");
  let fileValues = {};
  try {
    fileValues = parseEnvironmentFile(await readFile(filePath, "utf8"));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }

  const values = { ...fileValues };
  for (const [name, value] of Object.entries(environment)) {
    if (
      /^GITHUB_TOKEN(?:_[A-Z0-9_-]+)?$/i.test(name) &&
      typeof value === "string" &&
      value.trim()
    ) {
      values[name] = value.trim();
    }
  }
  const tokenName = Object.keys(values).sort((left, right) => {
    if (left.toUpperCase() === "GITHUB_TOKEN") return -1;
    if (right.toUpperCase() === "GITHUB_TOKEN") return 1;
    return left.localeCompare(right);
  })[0];
  return tokenName ? values[tokenName] : null;
}

function gitEnvironment(token, environment = process.env) {
  const env = { ...environment };
  if (!token) return env;
  env.GIT_CONFIG_COUNT = "1";
  env.GIT_CONFIG_KEY_0 = "http.https://github.com/.extraheader";
  env.GIT_CONFIG_VALUE_0 = `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${token}`).toString("base64")}`;
  return env;
}

async function verifyGitHubAccess(token, fetchImplementation = fetch) {
  let response;
  try {
    response = await fetchImplementation(gupApiEndpoint, {
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
        "X-GitHub-Api-Version": "2022-11-28"
      },
      signal: AbortSignal.timeout(15000)
    });
  } catch (error) {
    throw new Error(`Could not verify access to the private gup repository: ${error.message}`);
  }

  if (response.status === 401) {
    throw new Error("GITHUB_TOKEN was rejected by GitHub. Replace it with a valid token that can read Tomasz-Gziut/gup.");
  }
  if (response.status === 403) {
    throw new Error("GitHub denied access to Tomasz-Gziut/gup. Check the token's repository permissions and organization SSO authorization.");
  }
  if (response.status === 404) {
    throw new Error("GitHub returned 404 for the private Tomasz-Gziut/gup repository. Set GITHUB_TOKEN to a token authorized to access this repository, with Contents: read permission.");
  }
  if (!response.ok) {
    throw new Error(`GitHub could not verify access to Tomasz-Gziut/gup (HTTP ${response.status}).`);
  }

  const repository = await response.json();
  if (repository.full_name?.toLowerCase() !== "tomasz-gziut/gup") {
    throw new Error("GitHub returned an unexpected repository while verifying access to Tomasz-Gziut/gup.");
  }
}

function runGit(args, cwd = agentRoot, token) {
  const result = spawnSync("git", args, {
    cwd,
    stdio: "inherit",
    env: gitEnvironment(token)
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed with status ${result.status}.`);
  }
}

async function copyAgentEnvironment(sourceRoot, targetRoot) {
  const source = path.join(sourceRoot, ".env");
  const destination = path.join(targetRoot, ".env");
  if (!(await pathExists(source))) {
    await rm(destination, { force: true });
    return false;
  }
  await copyFile(source, destination);
  if (process.platform !== "win32") await chmod(destination, 0o600);
  return true;
}

async function prepareGup(root = agentRoot) {
  const gupRoot = path.join(root, "gup");
  const token = await findGitHubToken(root);
  if (!token) {
    throw new Error(
      "The gup repository is private. Set GITHUB_TOKEN in the Repo Agent .env file or as a Render environment secret with read access to Tomasz-Gziut/gup."
    );
  }
  await verifyGitHubAccess(token);
  if (await pathExists(path.join(gupRoot, ".git"))) {
    runGit(["-C", gupRoot, "pull", "--ff-only"], root, token);
  } else if (await pathExists(gupRoot)) {
    throw new Error(`${gupRoot} exists but is not a Git repository.`);
  } else {
    runGit(["clone", "--depth", "1", gupRepository, gupRoot], root, token);
  }

  if (await copyAgentEnvironment(root, gupRoot)) {
    console.log("Copied the Repo Agent .env file to the gup checkout.");
  }
}

if (require.main === module) {
  prepareGup().catch((error) => {
    console.error(`Failed to prepare gup: ${error.message}`);
    process.exitCode = 1;
  });
}

module.exports = {
  copyAgentEnvironment,
  findGitHubToken,
  gitEnvironment,
  parseEnvironmentFile,
  prepareGup,
  verifyGitHubAccess
};
