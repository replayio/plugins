import { chmod, cp, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import type { Connector } from "./connectors.ts";
import { plugin } from "./config.ts";

interface SourceContent {
  readonly skill: string;
  readonly cli: string;
  readonly workflows: string;
  readonly agents: string;
}

interface RenderOptions {
  readonly pwcliExport: string;
  readonly titleSuffix: string;
  readonly analysisSurface: string;
  readonly analysisTools: string;
  readonly authNote: string;
  /** Injected into the skill (e.g. Cursor-specific IDE browser warning). Empty string omits. */
  readonly agentBrowserWarning?: string;
  /** Full README body; default is a short generic maintainer note. */
  readonly readme?: string;
}

export interface BuildContext {
  readonly root: string;
  readonly source: SourceContent;
  readonly outputPath: (relativePath: string) => string;
  readonly copySource: (relativePath: string, destination: string) => Promise<void>;
  readonly copyScript: (relativePath: string, destination: string) => Promise<void>;
  readonly copyConnectorArtifacts: (connector: Connector, out: string) => Promise<void>;
  readonly writeJson: (file: string, value: unknown) => Promise<void>;
  readonly writeText: (file: string, value: string) => Promise<void>;
  readonly writeSharedPluginFiles: (out: string, options: RenderOptions) => Promise<void>;
}

export async function createBuildContext(root: string): Promise<BuildContext> {
  const source = {
    skill: await readSource(root, "content/skill.md"),
    cli: await readSource(root, "content/cli.md"),
    workflows: await readSource(root, "content/workflows.md"),
    agents: await readSource(root, "content/agents.md"),
  };

  return {
    root,
    source,
    outputPath: (relativePath) => path.join(root, relativePath),
    copySource: (relativePath, destination) => copySource(root, relativePath, destination),
    copyScript: (relativePath, destination) => copyScript(root, relativePath, destination),
    copyConnectorArtifacts: (connector, out) => copyConnectorArtifacts(root, connector, out),
    writeJson,
    writeText,
    writeSharedPluginFiles: (out, options) => writeSharedPluginFiles(root, source, out, options),
  };
}

export function claudeStyleHooks(rootExpression: string): unknown {
  return {
    hooks: {
      PostToolUse: [
        {
          matcher: "Bash",
          hooks: [
            {
              type: "command",
              command: `${rootExpression}/scripts/post_bash_upload.sh`,
            },
          ],
        },
      ],
      Stop: [
        {
          hooks: [
            {
              type: "command",
              command: `${rootExpression}/scripts/stop_close_and_upload.sh`,
            },
          ],
        },
      ],
    },
  };
}

export function replaceKeyword(keywords: readonly string[], keyword: string): string[] {
  return keywords.map((value) => (value === "mcp" ? keyword : value));
}

async function writeSharedPluginFiles(
  root: string,
  source: SourceContent,
  out: string,
  options: RenderOptions,
): Promise<void> {
  await copySource(root, "assets/replayio.svg", path.join(out, "assets/replayio.svg"));
  await copySource(root, "LICENSE", path.join(out, "LICENSE"));
  await copyScript(root, "scripts/playwright_cli.sh", path.join(out, "skills/replayio/scripts/playwright_cli.sh"));
  await copyScript(root, "scripts/post_bash_upload.sh", path.join(out, "scripts/post_bash_upload.sh"));
  await copyScript(root, "scripts/stop_close_and_upload.sh", path.join(out, "scripts/stop_close_and_upload.sh"));

  await writeText(path.join(out, "skills/replayio/SKILL.md"), render(source.skill, options));
  await writeText(path.join(out, "skills/replayio/references/cli.md"), render(source.cli, options));
  await writeText(path.join(out, "skills/replayio/references/workflows.md"), render(source.workflows, options));
  const readme =
    options.readme ??
    `# ${plugin.displayName} Plugin

Generated from \`src/\` in the Replay.io agent plugins repo.

This bundle includes the Replay browser skill, upload/cleanup scripts, and the platform-specific integration config for this target.
`;
  await writeText(path.join(out, "README.md"), readme);
}

async function copyConnectorArtifacts(root: string, connector: Connector, out: string): Promise<void> {
  for (const artifact of connector.artifacts) {
    await copySource(root, artifact.source, path.join(out, artifact.destination));
  }
}

function render(text: string, options: RenderOptions): string {
  const warning = options.agentBrowserWarning ?? "";
  return text
    .replaceAll("{{PWCLI_EXPORT}}", options.pwcliExport)
    .replaceAll("{{TITLE_SUFFIX}}", options.titleSuffix)
    .replaceAll("{{ANALYSIS_SURFACE}}", options.analysisSurface)
    .replaceAll("{{ANALYSIS_TOOLS}}", options.analysisTools)
    .replaceAll("{{AUTH_NOTE}}", options.authNote)
    .replaceAll("{{AGENT_BROWSER_WARNING}}", warning);
}

async function readSource(root: string, relativePath: string): Promise<string> {
  return readFile(path.join(root, "src", relativePath), "utf8");
}

async function copySource(root: string, relativePath: string, destination: string): Promise<void> {
  await mkdir(path.dirname(destination), { recursive: true });
  await cp(path.join(root, "src", relativePath), destination);
}

async function copyScript(root: string, relativePath: string, destination: string): Promise<void> {
  await copySource(root, relativePath, destination);
  await chmod(destination, 0o755);
}

async function writeJson(file: string, value: unknown): Promise<void> {
  await writeText(file, `${JSON.stringify(value, null, 2)}\n`);
}

async function writeText(file: string, value: string): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, value);
}
