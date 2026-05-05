import path from "node:path";

import type { BuildContext } from "../build-helpers.ts";
import type { Connector } from "../connectors.ts";
import { connectors } from "../connectors.ts";
import { plugin } from "../config.ts";

/** Resolves the installed plugin root in Cursor hooks (Cursor-first; `.` if unset). */
const pluginRootShell = "${CURSOR_PLUGIN_ROOT:-${CLAUDE_PLUGIN_ROOT:-.}}";

/** Same order as hooks, with a dev fallback when neither env var is set (see skill \`PWCLI\` export). */
const pluginRootForPwcli = "${CURSOR_PLUGIN_ROOT:-${CLAUDE_PLUGIN_ROOT:-$PWD/dist/cursor/replayio}}";

const cursorIdeBrowserWarning = `## CRITICAL FOR CURSOR AGENTS

**DO NOT USE CURSOR'S INTERNAL BROWSER, SIMPLE BROWSER, PREVIEW PANE, EMBEDDED WEBVIEW, OR ANY IN-IDE "TEST IN BROWSER" / AGENT BROWSER FEATURE TO EXERCISE THE USER'S APP.**

**FOR EVERY REAL BROWSER SESSION, UI TEST, OR REPLAY RECORDING YOU MUST LAUNCH AND DRIVE THE REPLAY.IO BROWSER THROUGH \`PLAYWRIGHT-CLI\` WITH REPLAY CHROMIUM (THIS SKILL) — NOT THE IDE'S BUILT-IN BROWSER.**

`;

const cursorReadme = `# ${plugin.displayName} (Cursor)

Record browser sessions with the **Replay Browser** via Playwright CLI, inspect runs from the terminal, and use the **Replay MCP** server (\`mcp.json\`) after a recording uploads. Hooks upload pending recordings when Playwright closes a session and when the agent stops.

## Installation

- From a marketplace or multi-plugin repo: install the \`replayio\` entry that points at this folder (see the repo \`.cursor-plugin/marketplace.json\` \`source\`: \`${connectors.cursor.output}\`).
- From a checkout: in Cursor, add this directory (\`${connectors.cursor.output}\` in the built repo) as a local plugin, then reload if prompted.

Ensure **Node.js** (\`npx\`) and the **Replay CLI** (\`replayio\`) are available per \`skills/replayio/SKILL.md\`. Enable the \`replay\` MCP server in Cursor settings if it is not on by default.

## Replay MCP authentication

Most recordings are private. For Replay MCP tools to access your recordings (avoid **"Access denied"**), configure the MCP server with an API key:

- Set an environment variable: \`REPLAY_API_KEY=<your key>\` (recommended), or
- Put the header directly in the MCP server config: \`Authorization: <your key>\`

## What ships in this bundle

| Component | Path |
|-----------|------|
| Plugin manifest | \`.cursor-plugin/plugin.json\` |
| Agent skill | \`skills/replayio/SKILL.md\` (+ \`references/\`) |
| Hooks | \`hooks/hooks.json\` (after-shell close detection + stop cleanup) |
| MCP | \`mcp.json\` (Replay HTTP MCP) |
| Scripts | \`scripts/post_bash_upload.sh\`, \`scripts/stop_close_and_upload.sh\`, \`skills/replayio/scripts/playwright_cli.sh\` |
| Logo | \`assets/replayio.svg\` |

## CRITICAL: BROWSER CHOICE

**DO NOT USE CURSOR'S INTERNAL BROWSER OR IN-IDE WEBVIEW TO TEST APPS.** **USE THE REPLAY.IO BROWSER THROUGH \`PLAYWRIGHT-CLI\` AS DOCUMENTED IN THE SKILL.**

---

Generated from \`src/\` in the Replay.io agent plugins repo.
`;

async function build(context: BuildContext, connector: Connector): Promise<void> {
  const out = context.outputPath(connector.output);

  await context.writeJson(path.join(out, ".cursor-plugin/plugin.json"), {
    name: plugin.name,
    displayName: plugin.displayName,
    version: plugin.version,
    description:
      "Record browser sessions with the Replay Browser via Playwright CLI, analyze recordings through the Replay MCP server, and auto-upload recordings when the browser closes or the agent stops.",
    author: {
      name: plugin.developerName,
      url: plugin.homepage,
    },
    homepage: plugin.homepage,
    repository: plugin.repository,
    license: plugin.license,
    keywords: plugin.keywords,
    logo: "assets/replayio.svg",
    skills: "./skills/",
    hooks: "./hooks/hooks.json",
    mcpServers: "./mcp.json",
  });

  await context.copyConnectorArtifacts(connector, out);
  await context.writeJson(path.join(out, "hooks/hooks.json"), {
    hooks: {
      afterShellExecution: [
        {
          command: `bash "${pluginRootShell}/scripts/post_bash_upload.sh"`,
          matcher: "playwright.*close|pwcli.*close|PWCLI.*close",
        },
      ],
      stop: [
        {
          command: `bash "${pluginRootShell}/scripts/stop_close_and_upload.sh"`,
        },
      ],
    },
  });

  await context.writeSharedPluginFiles(out, {
    pwcliExport: `${pluginRootForPwcli}/skills/replayio/scripts/playwright_cli.sh`,
    titleSuffix: "Replay MCP",
    analysisSurface: "the Replay MCP server",
    analysisTools: "the `replay` MCP server tools",
    authNote: "Cursor connects to the Replay HTTP MCP server configured in `mcp.json`.",
    agentBrowserWarning: cursorIdeBrowserWarning,
    readme: cursorReadme,
  });
}

export default {
  name: connectors.cursor.id,
  connector: connectors.cursor,
  build,
};
