const { spawnSync } = require("node:child_process");
const { readFileSync } = require("node:fs");
const path = require("node:path");

const configPath = path.join(__dirname, "..", "config.json");
const config = JSON.parse(readFileSync(configPath, "utf8"));

if (!Array.isArray(config.terminalDependencies)) {
  throw new Error("config.json must define terminalDependencies as an array.");
}

for (const dependency of config.terminalDependencies) {
  if (!dependency || typeof dependency.name !== "string") {
    throw new Error("Each terminal dependency must have a name.");
  }
}

if (process.argv.includes("--check")) {
  console.log("Terminal dependency configuration is valid.");
  process.exit(0);
}

for (const dependency of config.terminalDependencies) {
  const command = typeof dependency.installCommand === "string"
    ? dependency.installCommand
    : dependency.installCommand[process.platform];

  console.log(`Installing ${dependency.name}...`);
  const result = process.platform === "win32"
    ? spawnSync("powershell.exe", ["-NoProfile", "-Command", command], { stdio: "inherit" })
    : spawnSync("/bin/sh", ["-c", command], { stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`Installation of ${dependency.name} failed with status ${result.status}.`);
  }
}
