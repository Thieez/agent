const { spawnSync } = require("node:child_process");
const { chmod, copyFile, access, rm } = require("node:fs/promises");
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

function runGit(args, cwd = agentRoot) {
  const result = spawnSync("git", args, { cwd, stdio: "inherit" });
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
  if (await pathExists(path.join(gupRoot, ".git"))) {
    runGit(["-C", gupRoot, "pull", "--ff-only"], root);
  } else if (await pathExists(gupRoot)) {
    throw new Error(`${gupRoot} exists but is not a Git repository.`);
  } else {
    runGit(["clone", "--depth", "1", gupRepository, gupRoot], root);
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

module.exports = { copyAgentEnvironment, prepareGup };
