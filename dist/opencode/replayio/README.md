# Replay.io OpenCode plugin

This generated bundle contains:

- `.opencode/plugins/replayio.js`: OpenCode plugin hooks for Replay recording env vars, `AGENT_BROWSER_EXECUTABLE_PATH`, legacy upload-after-close, and idle cleanup.
- `opencode.json`: Replay HTTP MCP server config.
- `AGENTS.md`: Replay workflow guidance.

If the target project already has `opencode.json`, merge the `mcpServers.replay` entry instead of replacing the file.
