// Built from hooks/detect.ts by `npm run build`: edit that.
const AGENT = /(^|[\s/"'])agent-browser["']?$/;
const OPEN_SCRIPT = /browser-open\.js["']?$/;
const CLOSE_SCRIPT = /browser-close\.js["']?$/;
const VALUE_FLAGS = /* @__PURE__ */ new Set([
  "-s",
  "--session",
  "--executable-path",
  "--init-script",
  "--enable",
  "--args",
  "--profile",
  "--session-name",
  "--state",
  "--headers",
  "--extension",
  "--user-agent",
  "--proxy",
  "--proxy-bypass",
  "--cdp",
  "--color-scheme",
  "--download-path",
  "--provider",
  "-p",
  "--device",
  "--engine",
  "--model",
  "--config",
  "--screenshot-dir",
  "--screenshot-quality",
  "--screenshot-format",
  "--max-output",
  "--allowed-domains",
  "--action-policy",
  "--confirm-actions"
]);
const NO_BROWSER = /* @__PURE__ */ new Set([
  "auth",
  "confirm",
  "dashboard",
  "deny",
  "doctor",
  "help",
  "install",
  "profiles",
  "session",
  "skills",
  "upgrade",
  "version"
]);
function words(segment) {
  const out = [];
  const re = /"((?:\\.|[^"\\])*)"|'([^']*)'|(\S+)/g;
  for (let m = re.exec(segment); m; m = re.exec(segment)) {
    out.push(m[1] ?? m[2] ?? m[3] ?? "");
  }
  return out;
}
function literal(value) {
  const unquoted = value?.replace(/["']/g, "");
  if (!unquoted || unquoted.includes("$") || unquoted.includes("`")) return null;
  return unquoted;
}
function sessionFlag(argv) {
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] ?? "";
    const eq = /^(?:-s|--session)=(.*)$/.exec(arg);
    if (eq) return eq[1] ?? "";
    if (arg === "-s" || arg === "--session") return argv[i + 1] ?? "";
  }
  return void 0;
}
function verb(argv) {
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] ?? "";
    if (VALUE_FLAGS.has(arg)) {
      i++;
      continue;
    }
    if (arg.startsWith("-") || arg.startsWith(">") || /^\d?>/.test(arg)) continue;
    return arg;
  }
  return null;
}
function aliases(command) {
  const agent = /* @__PURE__ */ new Set();
  const add = (name, body) => {
    if (!/agent-browser/.test(body)) return;
    agent.add(name);
    agent.add(`$${name}`);
    agent.add(`\${${name}}`);
  };
  for (const m of command.matchAll(/([A-Za-z_][\w-]*)\s*\(\)\s*\{([^}]*)\}/g)) add(m[1], m[2]);
  for (const m of command.matchAll(/\balias\s+([\w-]+)=(["'])(.*?)\2/g)) add(m[1], m[3]);
  for (const m of command.matchAll(/(?:^|[\s;&|])([A-Za-z_]\w*)=(["'])([^"']*)\2/g)) add(m[1], m[3]);
  return agent;
}
function joinDir(dir, target) {
  if (target.includes("$") || target.includes("`") || target.startsWith("~") || target === "-") return null;
  if (!target.startsWith("/") && dir === null) return null;
  const parts = target.startsWith("/") ? [] : (dir ?? "").split("/").filter(Boolean);
  for (const part of target.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") parts.pop();
    else parts.push(part);
  }
  return `/${parts.join("/")}`;
}
const SEGMENTS = /&&|\|\||[;\n|]/;
const RUNNERS = /* @__PURE__ */ new Set(["npx", "bunx", "pnpx", "pnpm", "yarn", "dlx", "exec", "command", "env", "time", "nohup", "sudo"]);
const SHELL_WORDS = /* @__PURE__ */ new Set(["then", "do", "else", "if", "while", "until", "!", "{", "("]);
function commandAt(argv) {
  let at = 0;
  while (at < argv.length && (/^[A-Za-z_]\w*=/.test(argv[at]) || argv[at] === "export" || SHELL_WORDS.has(argv[at]))) at++;
  return at;
}
function parseBrowserCommands(command, baseCwd = null) {
  const found = [];
  const alias = aliases(command);
  const env = {};
  let cwd = baseCwd;
  for (const segment of command.split(SEGMENTS)) {
    const argv = words(segment.trim());
    for (const w of argv) {
      const m = /^([A-Za-z_]\w*)=(.*)$/.exec(w);
      if (m) env[m[1]] = m[2].replace(/["']/g, "");
    }
    const cdAt = argv.findIndex((w) => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(w) && w !== "export");
    if (argv[cdAt] === "cd") {
      cwd = argv[cdAt + 1] === void 0 ? cwd : joinDir(cwd, argv[cdAt + 1]);
      continue;
    }
    const isCli = (w) => AGENT.test(w) || alias.has(w);
    const scriptAt = argv.findIndex((w) => OPEN_SCRIPT.test(w) || CLOSE_SCRIPT.test(w));
    if (scriptAt >= 0) {
      const flag2 = sessionFlag(argv.slice(scriptAt + 1));
      found.push({
        kind: OPEN_SCRIPT.test(argv[scriptAt]) ? "open" : "close",
        session: flag2 === void 0 ? null : literal(flag2),
        cwd
      });
      continue;
    }
    argv[commandAt(argv)] = (argv[commandAt(argv)] ?? "").replace(/^(?:\$\(|\()+/, "");
    let at = commandAt(argv);
    if (argv[at] !== void 0 && !isCli(argv[at]) && RUNNERS.has(argv[at])) {
      at = argv.findIndex((w, i) => i > at && isCli(w));
      if (at < 0) continue;
    }
    if (argv[at] === void 0 || !isCli(argv[at])) continue;
    while (argv[at + 1] !== void 0 && isCli(argv[at + 1])) at++;
    const rest = argv.slice(at + 1);
    const v = verb(rest);
    if (v === null || NO_BROWSER.has(v) || rest.includes("--help") || rest.includes("-h") || rest.includes("--version")) continue;
    const flag = sessionFlag(rest);
    const session = flag !== void 0 ? literal(flag) : env.AGENT_BROWSER_SESSION !== void 0 ? literal(env.AGENT_BROWSER_SESSION) : "default";
    if (v === "close") found.push({ kind: "close", session, cwd, ...rest.includes("--all") ? { all: true } : {} });
    else found.push({ kind: "open", session, cwd });
  }
  return found;
}
function openedSession(output) {
  return /"agent_browser_session"\s*:\s*"([^"]+)"/.exec(output)?.[1] ?? null;
}
function netEffect(commands) {
  const last = /* @__PURE__ */ new Map();
  for (const command of commands) {
    const key = command.all ? "*" : command.session ?? "";
    if (command.all) last.clear();
    last.delete(key);
    last.set(key, command);
  }
  return [...last.values()];
}
export {
  joinDir,
  netEffect,
  openedSession,
  parseBrowserCommands
};
