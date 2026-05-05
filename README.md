# Replay.io Agent Plugins

This repo builds the Replay.io integration for four agent/plugin ecosystems from one source tree:

- Codex: `dist/codex/replayio`
- Cursor: `dist/cursor/replayio`
- OpenCode: `dist/opencode/replayio`
- Claude Code: `dist/claude-code/replayio`

## Build

```bash
npm run build
npm run validate
```

Shared plugin content, assets, and source JSON artifacts live in `src/`. Build orchestration, connector mappings, target strategies, and target-specific inline code live in `lib/`. Generated plugin bundles are written to `dist/`.

## Platform Notes

- The root Cursor marketplace lives at `.cursor-plugin/marketplace.json` and points to `dist/cursor/replayio`.
- Codex uses `.codex-plugin/plugin.json` plus `.app.json` for the Replay ChatGPT app binding.
- Cursor uses `.cursor-plugin/plugin.json` plus root-level `mcp.json`.
- OpenCode uses `.opencode/plugins/replayio.js` plus `opencode.json` for MCP configuration.
- Claude Code uses `.claude-plugin/plugin.json` plus root-level `.mcp.json`.

Connector mappings in `lib/connectors.ts` copy source artifacts into each bundle:

- `src/.app.json` -> `dist/codex/replayio/.app.json`
- `src/.mcp.json` -> `dist/cursor/replayio/mcp.json`
- `src/.mcp.json` -> `dist/opencode/replayio/opencode.json`
- `src/.mcp.json` -> `dist/claude-code/replayio/.mcp.json`

Cursor, OpenCode, and Claude Code use the Replay HTTP MCP server:

```json
{"mcpServers":{"replay":{"type":"http","url":"https://dispatch.replay.io/mcp"}}}
```

Codex uses the ChatGPT app id configured in `src/.app.json`.
