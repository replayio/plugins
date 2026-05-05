# Replay.io (Cursor)

Record browser sessions with the **Replay Browser** via Playwright CLI, inspect runs from the terminal, and use the **Replay MCP** server (`mcp.json`) after a recording uploads. Hooks upload pending recordings when Playwright closes a session and when the agent stops.

## Installation

- From a marketplace or multi-plugin repo: install the `replayio` entry that points at this folder (see the repo `.cursor-plugin/marketplace.json` `source`: `dist/cursor/replayio`).
- From a checkout: in Cursor, add this directory (`dist/cursor/replayio` in the built repo) as a local plugin, then reload if prompted.

Ensure **Node.js** (`npx`) and the **Replay CLI** (`replayio`) are available per `skills/replayio/SKILL.md`. Enable the `replay` MCP server in Cursor settings if it is not on by default.

## Replay MCP authentication

Most recordings are private. For Replay MCP tools to access your recordings (avoid **"Access denied"**), configure the MCP server with an API key:

- Set an environment variable: `REPLAY_API_KEY=<your key>` (recommended), or
- Put the header directly in the MCP server config: `Authorization: <your key>`

## What ships in this bundle

| Component | Path |
|-----------|------|
| Plugin manifest | `.cursor-plugin/plugin.json` |
| Agent skill | `skills/replayio/SKILL.md` (+ `references/`) |
| Hooks | `hooks/hooks.json` (after-shell close detection + stop cleanup) |
| MCP | `mcp.json` (Replay HTTP MCP) |
| Scripts | `scripts/post_bash_upload.sh`, `scripts/stop_close_and_upload.sh`, `skills/replayio/scripts/playwright_cli.sh` |
| Logo | `assets/replayio.svg` |

## CRITICAL: BROWSER CHOICE

**DO NOT USE CURSOR'S INTERNAL BROWSER OR IN-IDE WEBVIEW TO TEST APPS.** **USE THE REPLAY.IO BROWSER THROUGH `PLAYWRIGHT-CLI` AS DOCUMENTED IN THE SKILL.**

---

Generated from `src/` in the Replay.io agent plugins repo.
