const { spawnSync } = require("node:child_process");
const { chmod, copyFile, access, readFile, rm } = require("node:fs/promises");
const path = require("node:path");

const agentRoot = path.resolve(__dirname, "..");
const gupRoot = path.join(agentRoot, "gup");
const gupRepository = "https://github.com/Tomasz-Gziut/gup.git";

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
  prepareGup
};
