# Replay.io (Codex)

Record browser sessions with the **Replay Browser** through the host agent browser. Set `AGENT_BROWSER_EXECUTABLE_PATH` to Replay Chromium before opening the browser, inspect the live run through the browser tool, and use the **Replay MCP** server (`.mcp.json`) after a recording uploads. Hooks upload pending recordings when the Codex turn stops.

## MCP widgets

The Codex plugin exposes Replay MCP directly through `https://dispatch.replay.io/mcp`. That server can attach MCP Apps widget metadata to tool descriptors:

- `_meta.ui.resourceUri` for MCP Apps-compatible hosts.
- `_meta["openai/outputTemplate"]` as the ChatGPT/OpenAI compatibility alias.
- `structuredContent` for widget rendering while preserving text `content` for model narration.

When the backend returns Replay widget results, Codex can render inspector-style cards for logpoints, console messages, React trees, Redux state, network requests, screenshots, source views, profiles, and exception stacks.

## What ships in this bundle

| Component | Path |
|-----------|------|
| Plugin manifest | `.codex-plugin/plugin.json` |
| Connected Replay app | `.app.json` |
| Replay HTTP MCP server | `.mcp.json` |
| Agent skill | `skills/replayio/SKILL.md` (+ `references/`) |
| Hooks | `hooks.json` |
| Scripts | `scripts/post_bash_upload.sh`, `scripts/stop_close_and_upload.sh` |
| Logo | `assets/replayio.svg` |

Generated from `src/` in the Replay.io agent plugins repo.
