const path = require("node:path");

function childEnvironment(environment = process.env) {
  const env = { ...environment };
  delete env.APP_PASSWORD;
  delete env.GH_TOKEN;
  delete env.COPILOT_GITHUB_TOKEN;
  delete env.COPILOT_HOME;
  for (const name of Object.keys(env)) {
    if (/^GITHUB_TOKEN(?:_[A-Z0-9_]+)?$/i.test(name)) delete env[name];
  }
  return env;
}

function terminalEnvironment(copilotToken, environment = process.env) {
  const env = childEnvironment(environment);
  const copilotBin = path.join(__dirname, "node_modules", ".bin");
  env.PATH = [copilotBin, env.PATH].filter(Boolean).join(path.delimiter);
  if (copilotToken) env.COPILOT_GITHUB_TOKEN = copilotToken;
  return env;
}

module.exports = { childEnvironment, terminalEnvironment };
