const childProcess = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const DEFAULT_API_BASE = "https://qa.replay.io/api/v1";
const DEFAULT_INSTRUCTIONS =
  "Explore the app and test the main features. Focus on broken flows, validation, auth, navigation, persistence, and visible UI regressions.";

function parseArgs(argv) {
  const args = { _: [] };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === "--") {
      args._.push(...argv.slice(index + 1));
      break;
    }

    if (!arg.startsWith("--")) {
      args._.push(arg);
      continue;
    }

    if (arg.startsWith("--no-")) {
      args[toCamel(arg.slice(5))] = false;
      continue;
    }

    const equalsIndex = arg.indexOf("=");
    if (equalsIndex !== -1) {
      const key = toCamel(arg.slice(2, equalsIndex));
      args[key] = arg.slice(equalsIndex + 1);
      continue;
    }

    const key = toCamel(arg.slice(2));
    const next = argv[index + 1];
    if (next && !next.startsWith("--")) {
      args[key] = next;
      index += 1;
    } else {
      args[key] = true;
    }
  }

  return args;
}

function toCamel(value) {
  return value.replace(/-([a-z])/g, (_, char) => char.toUpperCase());
}

function getProjectRoot() {
  try {
    return childProcess.execFileSync("git", ["rev-parse", "--show-toplevel"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return process.cwd();
  }
}

function getConfigPath(root = getProjectRoot()) {
  return path.join(root, ".replay", "config.json");
}

function readJsonFile(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return undefined;
  }
}

function readConfig(root = getProjectRoot()) {
  const config = readJsonFile(getConfigPath(root));
  return config && typeof config === "object" && !Array.isArray(config) ? config : {};
}

function getConfigProjectId(root = getProjectRoot()) {
  const id = readConfig(root)["qa-project-id"];
  return typeof id === "string" && id.trim() ? id.trim() : "";
}

function writeConfigProjectId(projectId, root = getProjectRoot()) {
  if (!projectId) {
    throw new Error("Cannot write an empty Replay QA project id.");
  }

  const configPath = getConfigPath(root);
  const current = readConfig(root);
  const existing = current["qa-project-id"];

  if (typeof existing === "string" && existing.trim() && existing.trim() !== projectId) {
    throw new Error(
      `.replay/config.json already contains qa-project-id ${existing.trim()}; not overwriting it with ${projectId}.`
    );
  }

  const next = { ...current, "qa-project-id": projectId };
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, `${JSON.stringify(next, null, 2)}\n`);
  return configPath;
}

function findKeyDeep(value, key) {
  if (!value || typeof value !== "object") {
    return "";
  }

  if (Object.prototype.hasOwnProperty.call(value, key) && typeof value[key] === "string") {
    return value[key];
  }

  for (const child of Object.values(value)) {
    const found = findKeyDeep(child, key);
    if (found) {
      return found;
    }
  }

  return "";
}

function getAuthToken() {
  const envToken =
    process.env.REPLAY_QA_API_KEY ||
    process.env.REPLAY_API_KEY ||
    process.env.REPLAY_ACCESS_TOKEN;

  if (envToken && envToken.trim()) {
    return envToken.trim();
  }

  const profilePath = path.join(os.homedir(), ".replay", "profile", "auth.json");
  const profile = readJsonFile(profilePath);
  const accessToken = findKeyDeep(profile, "accessToken");

  if (accessToken) {
    return accessToken;
  }

  throw new Error(
    "Replay QA auth token not found. Run `npx replayio login`, then `npx replayio whoami`, or export REPLAY_QA_API_KEY/REPLAY_API_KEY."
  );
}

function getApiBase() {
  return (process.env.REPLAY_QA_API_BASE || DEFAULT_API_BASE).replace(/\/+$/, "");
}

function withQuery(apiPath, query = {}) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null || value === "" || value === false) {
      continue;
    }
    params.set(toSnake(key), String(value));
  }
  const queryString = params.toString();
  return queryString ? `${apiPath}?${queryString}` : apiPath;
}

function toSnake(value) {
  return value.replace(/[A-Z]/g, (char) => `_${char.toLowerCase()}`);
}

async function apiRequest(method, apiPath, body, query) {
  const url = `${getApiBase()}${withQuery(apiPath, query)}`;
  const response = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${getAuthToken()}`,
      "Content-Type": "application/json",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  const text = await response.text();
  let data;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = text;
  }

  if (!response.ok) {
    const details = typeof data === "string" ? data : JSON.stringify(data, null, 2);
    if (response.status === 401) {
      throw new Error(
        `Replay QA API returned 401 for ${method} ${apiPath}. Export a Replay QA API token as REPLAY_QA_API_KEY or REPLAY_API_KEY.\n${details}`
      );
    }
    throw new Error(`Replay QA API returned ${response.status} for ${method} ${apiPath}.\n${details}`);
  }

  return data;
}

function extractProjectId(response) {
  return (
    response?.project_id ||
    response?.id ||
    response?.project?.id ||
    response?.project?.project_id ||
    ""
  );
}

function getFirstUrlArg(args) {
  const first = args._[0];
  return typeof first === "string" && /^https?:\/\//.test(first) ? first : "";
}

function getInstructionsArg(args, fallback = DEFAULT_INSTRUCTIONS) {
  if (typeof args.instructions === "string" && args.instructions.trim()) {
    return args.instructions.trim();
  }

  const skipFirst = getFirstUrlArg(args) ? 1 : 0;
  const positional = args._.slice(skipFirst).join(" ").trim();
  return positional || fallback;
}

function getProjectName(args, root = getProjectRoot()) {
  if (typeof args.name === "string" && args.name.trim()) {
    return args.name.trim();
  }
  return path.basename(root) || "Replay QA project";
}

function shouldUseReverseProxy(args, targetUrl) {
  if (args.public === true || args.useReverseProxy === false || args.reverseProxy === false) {
    return false;
  }
  if (args.useReverseProxy === true || args.reverseProxy === true) {
    return true;
  }
  return /^https?:\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(?::|\/|$)/.test(targetUrl);
}

function readOptionalFile(filePath) {
  if (!filePath || filePath === true) {
    return "";
  }
  return fs.readFileSync(path.resolve(filePath), "utf8");
}

function parseJsonOption(value, optionName) {
  if (!value || value === true) {
    return undefined;
  }
  try {
    return JSON.parse(value);
  } catch (error) {
    throw new Error(`Could not parse ${optionName} as JSON: ${error.message}`);
  }
}

async function createProject(args = {}, root = getProjectRoot()) {
  const targetUrl = args.targetUrl || getFirstUrlArg(args) || "http://localhost:3000";
  const recordingId = args.recordingId;
  const body = {
    name: getProjectName(args, root),
    instructions: getInstructionsArg(args),
  };

  if (recordingId) {
    body.recording_id = recordingId;
  } else {
    body.target_url = targetUrl;
    body.use_reverse_proxy = shouldUseReverseProxy(args, targetUrl);
  }

  const designDocument = readOptionalFile(args.designDocument);
  if (designDocument) {
    body.design_document = designDocument;
  }

  if (args.webhookUrl) {
    body.webhook_url = args.webhookUrl;
  }
  if (args.finishedWebhookUrl) {
    body.finished_webhook_url = args.finishedWebhookUrl;
  }
  if (args.backendRecordingUrl) {
    body.backend_recording_url = args.backendRecordingUrl;
  }
  if (args.backendLogUrl) {
    body.backend_log_url = args.backendLogUrl;
  }

  const loginsJson = parseJsonOption(args.loginsJson, "--logins-json");
  if (loginsJson) {
    body.logins = loginsJson;
  } else if (args.loginEmail && args.loginPassword) {
    body.logins = [{ email: args.loginEmail, password: args.loginPassword }];
  }

  const response = await apiRequest("POST", "/projects", body);
  const projectId = extractProjectId(response);
  if (!projectId) {
    throw new Error(`Could not find project id in createProject response:\n${JSON.stringify(response, null, 2)}`);
  }

  const configPath = writeConfigProjectId(projectId, root);
  return { projectId, configPath, response, created: true };
}

async function ensureProject(args = {}) {
  const root = getProjectRoot();
  const configId = args.ignoreConfig ? "" : getConfigProjectId(root);
  if (configId) {
    return { projectId: configId, source: "config", root, configPath: getConfigPath(root) };
  }

  const explicitId = args.projectId || process.env.REPLAY_QA_PROJECT_ID;
  if (explicitId) {
    return { projectId: explicitId, source: args.projectId ? "argument" : "environment", root, configPath: getConfigPath(root) };
  }

  if (args.create === false) {
    throw new Error(
      "No Replay QA project id found. Run bootstrap.js/full-qa.js first or pass --project-id."
    );
  }

  const created = await createProject(args, root);
  return { ...created, source: "created", root };
}

async function getProjectId(args = {}) {
  return ensureProject({ ...args, create: false });
}

function findObjectsByKeyValue(value, key, expected) {
  const matches = [];
  visitObjects(value, (object) => {
    if (object[key] === expected) {
      matches.push(object);
    }
  });
  return matches;
}

function extractIds(value) {
  const ids = new Set();
  visitObjects(value, (object) => {
    if (typeof object.id === "string" && object.id.trim()) {
      ids.add(object.id.trim());
    }
  });
  return [...ids].sort();
}

function visitObjects(value, visitor) {
  if (!value || typeof value !== "object") {
    return;
  }
  if (!Array.isArray(value)) {
    visitor(value);
  }
  for (const child of Object.values(value)) {
    visitObjects(child, visitor);
  }
}

function printJson(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function printSection(title, value) {
  process.stdout.write(`\n=== ${title} ===\n`);
  if (typeof value === "string") {
    process.stdout.write(`${value}\n`);
  } else {
    printJson(value);
  }
}

function handleError(error) {
  process.stderr.write(`${error.stack || error.message || error}\n`);
  process.exit(1);
}

module.exports = {
  DEFAULT_API_BASE,
  DEFAULT_INSTRUCTIONS,
  apiRequest,
  createProject,
  ensureProject,
  extractIds,
  findObjectsByKeyValue,
  getConfigPath,
  getConfigProjectId,
  getInstructionsArg,
  getProjectId,
  getProjectRoot,
  handleError,
  parseArgs,
  printJson,
  printSection,
  writeConfigProjectId,
};
