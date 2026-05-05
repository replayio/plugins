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
      "Record browser sessions with the Replay Browser via Playwright CLI, analyze recordings through the connected Replay ChatGPT app, and auto-upload recordings when the browser closes or the turn ends.",
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
    hooks: "./hooks.json",
    interface: {
      displayName: plugin.displayName,
      shortDescription: "Record browser sessions and analyze recordings",
      longDescription:
        "Drive a real browser with Playwright CLI against the Replay Browser to capture time-travel debuggable recordings, auto-upload them on close, and analyze uploaded recordings through the connected Replay ChatGPT app.",
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
    titleSuffix: "Replay App",
    analysisSurface: "the connected Replay app",
    analysisTools: "the connected Replay app tools",
    authNote:
      "This plugin does not launch a local MCP server; app authentication and tool exposure are handled by the connected Replay app.",
  });
}

export default {
  name: connectors.codex.id,
  connector: connectors.codex,
  build,
};
