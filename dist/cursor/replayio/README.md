# Replay.io (Cursor)

Record browser sessions with the **Replay Browser** through Cursor's agent browser. Set `AGENT_BROWSER_EXECUTABLE_PATH` to Replay Chromium before opening the browser, inspect the live run through the browser tool, and use the **Replay MCP** server (`mcp.json`) after a recording uploads. Hooks upload pending recordings when the agent stops.

## Installation

- From a marketplace or multi-plugin repo: install the `replayio` entry that points at this folder (see the repo `.cursor-plugin/marketplace.json` `source`: `dist/cursor/replayio`).
- From a checkout: in Cursor, add this directory (`dist/cursor/replayio` in the built repo) as a local plugin, then reload if prompted.

Ensure the **Replay CLI** (`replayio`) is available per `skills/replayio/SKILL.md`. Enable the `replay` MCP server in Cursor settings if it is not on by default.

## Replay MCP authentication (OAuth)

This plugin wires Replay MCP to `https://dispatch.replay.io/mcp` using Cursor’s **remote HTTP MCP** support. Cursor should prompt you to **sign in** via **OAuth** (and **dynamic client registration** when the server supports it).

If tools return **Access denied**, open **Cursor Settings → MCP**, find **Replay**, and use **Reconnect / Sign in** so the OAuth session matches the Replay account that owns the recording.

## What ships in this bundle

| Component | Path |
|-----------|------|
| Plugin manifest | `.cursor-plugin/plugin.json` |
| Agent skill | `skills/replayio/SKILL.md` (+ `references/`) |
| Hooks | `hooks/hooks.json` (after-shell close detection + stop cleanup) |
| MCP | `mcp.json` (Replay HTTP MCP) |
| Scripts | `scripts/post_bash_upload.sh`, `scripts/stop_close_and_upload.sh` |
| Logo | `assets/replayio.svg` |

## Browser Choice

Use an agent browser that honors `AGENT_BROWSER_EXECUTABLE_PATH` so the run uses Replay Chromium. Do not use a preview pane or embedded webview that cannot select the Replay executable.

---

Generated from `src/` in the Replay.io agent plugins repo.
