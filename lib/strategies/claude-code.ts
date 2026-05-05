import path from "node:path";

import type { BuildContext } from "../build-helpers.ts";
import type { Connector } from "../connectors.ts";
import { claudeStyleHooks } from "../build-helpers.ts";
import { connectors } from "../connectors.ts";
import { plugin } from "../config.ts";

async function build(context: BuildContext, connector: Connector): Promise<void> {
  const out = context.outputPath(connector.output);

  await context.writeJson(path.join(out, ".claude-plugin/plugin.json"), {
    name: plugin.name,
    version: plugin.version,
    description:
      "Record browser sessions with the Replay Browser via Playwright CLI, analyze recordings through the Replay MCP server, and auto-upload recordings when the browser closes or Claude Code stops.",
    author: {
      name: plugin.developerName,
      url: plugin.homepage,
    },
    homepage: plugin.homepage,
    repository: plugin.repository,
    license: plugin.license,
    keywords: plugin.keywords,
  });

  await context.copyConnectorArtifacts(connector, out);
  await context.writeJson(path.join(out, "hooks/hooks.json"), claudeStyleHooks("${CLAUDE_PLUGIN_ROOT}"));
  await context.writeSharedPluginFiles(out, {
    pwcliExport: '${CLAUDE_PLUGIN_ROOT:-$PWD/dist/claude-code/replayio}/skills/replayio/scripts/playwright_cli.sh',
    titleSuffix: "Replay MCP",
    analysisSurface: "the Replay MCP server",
    analysisTools: "the `replay` MCP server tools",
    authNote: "Claude Code connects to the Replay HTTP MCP server configured in `.mcp.json`.",
  });
}

export default {
  name: connectors.claudeCode.id,
  connector: connectors.claudeCode,
  build,
};
