import path from "node:path";

import type { BuildContext } from "../build-helpers.ts";
import type { Connector } from "../connectors.ts";
import { claudeStyleHooks, replaceKeyword } from "../build-helpers.ts";
import { connectors } from "../connectors.ts";
import { plugin } from "../config.ts";

async function build(context: BuildContext, connector: Connector): Promise<void> {
  const out = context.outputPath(connector.output);

  await context.writeJson(path.join(out, ".codex-plugin/plugin.json"), {
    name: plugin.name,
    version: plugin.version,
    description:
      "Record browser sessions with the Replay Browser via Playwright CLI, analyze recordings through Replay MCP tools with rich inspector widgets, and auto-upload recordings when the browser closes or the turn ends.",
    author: {
      name: plugin.developerName,
      url: plugin.homepage,
    },
    homepage: plugin.homepage,
    repository: plugin.repository,
    license: plugin.license,
    keywords: replaceKeyword(plugin.keywords, "chatgpt-app"),
    skills: "./skills/",
    apps: "./.app.json",
    mcpServers: "./.mcp.json",
    hooks: "./hooks.json",
    interface: {
      displayName: plugin.displayName,
      shortDescription: "Record browser sessions and inspect Replay recordings",
      longDescription:
        "Drive a real browser with Playwright CLI against the Replay Browser to capture time-travel debuggable recordings, auto-upload them on close, and analyze uploaded recordings through Replay MCP tools. In MCP Apps-aware hosts, Replay tool results can render rich debugging widgets for logpoints, console output, React trees, Redux state, network requests, screenshots, source code, profiles, and exception stacks.",
      developerName: plugin.developerName,
      category: "Coding",
      capabilities: ["Interactive", "Read", "Write"],
      websiteURL: plugin.homepage,
      privacyPolicyURL: "https://replay.io/privacy",
      termsOfServiceURL: "https://replay.io/terms",
      defaultPrompt: [
        "Record a Playwright session against this local app and analyze the resulting recording",
      ],
      brandColor: plugin.brandColor,
      composerIcon: "./assets/replayio.svg",
      logo: "./assets/replayio.svg",
      screenshots: [],
    },
  });

  await context.copyConnectorArtifacts(connector, out);
  await context.writeJson(path.join(out, "hooks.json"), claudeStyleHooks("${CLAUDE_PLUGIN_ROOT:-.}"));
  await context.writeSharedPluginFiles(out, {
    pwcliExport: '${CLAUDE_PLUGIN_ROOT:-$PWD/dist/codex/replayio}/skills/replayio/scripts/playwright_cli.sh',
    titleSuffix: "Replay MCP",
    analysisSurface: "the Replay MCP server",
    analysisTools: "the `replay` MCP server tools",
    authNote:
      "Codex connects to the Replay HTTP MCP server configured in `.mcp.json`; the connected Replay app id remains available in `.app.json` for app-level authentication and compatibility.",
    readme: `# ${plugin.displayName} (Codex)

Record browser sessions with the **Replay Browser** via Playwright CLI, inspect runs from the terminal, and use the **Replay MCP** server (\`.mcp.json\`) after a recording uploads. Hooks upload pending recordings when Playwright closes a session and when the Codex turn stops.

## MCP widgets

The Codex plugin exposes Replay MCP directly through \`https://dispatch.replay.io/mcp\`. That server can attach MCP Apps widget metadata to tool descriptors:

- \`_meta.ui.resourceUri\` for MCP Apps-compatible hosts.
- \`_meta["openai/outputTemplate"]\` as the ChatGPT/OpenAI compatibility alias.
- \`structuredContent\` for widget rendering while preserving text \`content\` for model narration.

When the backend returns Replay widget results, Codex can render inspector-style cards for logpoints, console messages, React trees, Redux state, network requests, screenshots, source views, profiles, and exception stacks.

## What ships in this bundle

| Component | Path |
|-----------|------|
| Plugin manifest | \`.codex-plugin/plugin.json\` |
| Connected Replay app | \`.app.json\` |
| Replay HTTP MCP server | \`.mcp.json\` |
| Agent skill | \`skills/replayio/SKILL.md\` (+ \`references/\`) |
| Hooks | \`hooks.json\` |
| Scripts | \`scripts/post_bash_upload.sh\`, \`scripts/stop_close_and_upload.sh\`, \`skills/replayio/scripts/playwright_cli.sh\` |
| Logo | \`assets/replayio.svg\` |

Generated from \`src/\` in the Replay.io agent plugins repo.
`,
  });
}

export default {
  name: connectors.codex.id,
  connector: connectors.codex,
  build,
};
