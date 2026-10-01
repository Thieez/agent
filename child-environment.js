const path = require("node:path");

function terminalEnvironment(environment = process.env) {
  const env = { ...environment };
  delete env.APP_PASSWORD;
  const copilotBin = path.join(__dirname, "node_modules", ".bin");
  env.PATH = [copilotBin, env.PATH].filter(Boolean).join(path.delimiter);
  return env;
}

module.exports = { terminalEnvironment };
