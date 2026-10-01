const path = require("node:path");

function terminalEnvironment(environment = process.env) {
  const env = { ...environment };
  delete env.APP_PASSWORD;
  const malformedTokenNames = [];
  for (const [name, value] of Object.entries(env)) {
    if (!/^GITHUB_TOKEN(?:_[A-Z0-9_-]+)?$/i.test(name) || typeof value !== "string") continue;
    const trimmedValue = value.trim();
    if (/\s/.test(trimmedValue)) {
      delete env[name];
      malformedTokenNames.push(name);
    } else {
      env[name] = trimmedValue;
    }
  }
  if (malformedTokenNames.length) {
    console.warn(
      `Ignoring malformed GitHub token environment variables in terminal: ${malformedTokenNames.join(", ")}.`
    );
  }
  const copilotBin = path.join(__dirname, "node_modules", ".bin");
  env.PATH = [copilotBin, env.PATH].filter(Boolean).join(path.delimiter);
  return env;
}

module.exports = { terminalEnvironment };
