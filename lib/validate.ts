import { spawnSync } from "node:child_process";
import { access, readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { connectorList, connectors } from "./connectors.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const requiredFiles = [
  ".cursor-plugin/marketplace.json",
  ...connectorList.flatMap((connector) =>
    connector.artifacts.map((artifact) => `${connector.output}/${artifact.destination}`),
  ),
  `${connectors.codex.output}/.codex-plugin/plugin.json`,
  `${connectors.codex.output}/hooks.json`,
  `${connectors.cursor.output}/.cursor-plugin/plugin.json`,
  `${connectors.cursor.output}/hooks/hooks.json`,
  `${connectors.opencode.output}/.opencode/plugins/replayio.js`,
  `${connectors.claudeCode.output}/.claude-plugin/plugin.json`,
  `${connectors.claudeCode.output}/hooks/hooks.json`,
];

for (const file of requiredFiles) {
  await access(path.join(root, file));
}

const cursorMarketplace = await readJson<CursorMarketplace>(path.join(root, ".cursor-plugin/marketplace.json"));
const cursorManifest = await readJson<CursorPluginManifest>(
  path.join(root, `${connectors.cursor.output}/.cursor-plugin/plugin.json`),
);
assertCursorMarketplace(cursorMarketplace, cursorManifest);
assertCursorPluginManifest(cursorManifest);
await assertCursorHooks(path.join(root, `${connectors.cursor.output}/hooks/hooks.json`));

for (const connector of connectorList) {
  for (const artifact of connector.artifacts) {
    const source = await readJson(path.join(root, "src", artifact.source));
    const output = await readJson(path.join(root, connector.output, artifact.destination));
    assertJsonEquals(`${connector.output}/${artifact.destination}`, output, source);
  }
}

for (const file of await jsonFiles(path.join(root, "dist"))) {
  JSON.parse(await readFile(file, "utf8"));
}

check(["node", "--check", path.join(root, `${connectors.opencode.output}/.opencode/plugins/replayio.js`)]);

if (commandExists("claude")) {
  check(["claude", "plugin", "validate", path.join(root, connectors.claudeCode.output)]);
}

console.log("Validation passed");

interface PluginManifest {
  readonly name: string;
}

interface CursorPluginManifest extends PluginManifest {
  readonly version?: string;
  readonly description?: string;
  readonly license?: string;
  readonly logo?: string;
}

interface CursorMarketplace {
  readonly plugins?: readonly {
    readonly name?: string;
    readonly source?: string;
  }[];
}

async function readJson<T = unknown>(file: string): Promise<T> {
  return JSON.parse(await readFile(file, "utf8"));
}

function assertJsonEquals(file: string, actual: unknown, expected: unknown): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${file} does not match its configured source artifact`);
  }
}

function assertCursorMarketplace(marketplace: CursorMarketplace, cursorManifest: PluginManifest): void {
  const entry = marketplace.plugins?.find((plugin) => plugin.name === cursorManifest.name);
  if (!entry) {
    throw new Error(`.cursor-plugin/marketplace.json is missing ${cursorManifest.name}`);
  }

  if (entry.source !== connectors.cursor.output) {
    throw new Error(`.cursor-plugin/marketplace.json must point ${cursorManifest.name} at ${connectors.cursor.output}`);
  }
}

function assertCursorPluginManifest(manifest: CursorPluginManifest): void {
  if (!manifest.version) {
    throw new Error("Cursor .cursor-plugin/plugin.json must include version");
  }
  if (!manifest.description) {
    throw new Error("Cursor .cursor-plugin/plugin.json must include description");
  }
  if (!manifest.license) {
    throw new Error("Cursor .cursor-plugin/plugin.json must include license");
  }
  if (manifest.logo && !manifest.logo.match(/^[a-zA-Z0-9_.-]+(\/[a-zA-Z0-9_.-]+)*$/)) {
    throw new Error("Cursor plugin logo must be a relative path without traversal");
  }
}

interface CursorHooksFile {
  readonly hooks?: {
    readonly afterShellExecution?: readonly { readonly command?: string }[];
    readonly stop?: readonly { readonly command?: string }[];
  };
}

async function assertCursorHooks(hooksPath: string): Promise<void> {
  const hooks = await readJson<CursorHooksFile>(hooksPath);
  const commands = [
    ...(hooks.hooks?.afterShellExecution ?? []).map((h) => h.command ?? ""),
    ...(hooks.hooks?.stop ?? []).map((h) => h.command ?? ""),
  ].filter(Boolean);

  if (commands.length === 0) {
    throw new Error("Cursor hooks/hooks.json must declare afterShellExecution and/or stop commands");
  }

  for (const cmd of commands) {
    if (!cmd.includes("CURSOR_PLUGIN_ROOT") || !cmd.includes("CLAUDE_PLUGIN_ROOT")) {
      throw new Error(
        `Each Cursor hook command must resolve the plugin root with CURSOR_PLUGIN_ROOT and CLAUDE_PLUGIN_ROOT (got: ${cmd})`,
      );
    }
  }
}

async function jsonFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await jsonFiles(full)));
    } else if (entry.name.endsWith(".json")) {
      files.push(full);
    }
  }
  return files;
}

function commandExists(command: string): boolean {
  const result = spawnSync("sh", ["-lc", `command -v ${command}`], {
    stdio: "ignore",
  });
  return result.status === 0;
}

function check(command: readonly string[]): void {
  const [bin, ...args] = command;
  if (!bin) {
    throw new Error("Command must include an executable");
  }
  const result = spawnSync(bin, args, {
    cwd: root,
    stdio: "inherit",
  });
  if (result.status !== 0) {
    throw new Error(`Command failed: ${command.join(" ")}`);
  }
}
