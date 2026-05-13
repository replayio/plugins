# Replay.io Plugin Guidance

Use the Replay browser workflow when a task needs a recorded browser session.

- Prefer direct `playwright-cli` inspection first: snapshots, console, network, screenshots, storage, cookies, and DOM reads.
- Set `PWCLI` from the plugin-provided shell environment or skill instructions and use `"$PWCLI"` for browser commands.
- Close the browser before reporting results: `"$PWCLI" --session="$SESSION" close`.
- Use Replay analysis tools only after a recording has uploaded and direct CLI output is not enough.
- If Replay MCP renders an inspector widget, use the widget as the primary debugging view and follow its point/source/component/request actions when useful.
- If Replay MCP authentication fails, reconnect or sign in through the agent host and retry.
