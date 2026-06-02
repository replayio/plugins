# Replay.io Plugin Guidance

Use the Replay browser workflow when a task needs a recorded browser session.

- Prefer the host agent browser with Replay Chromium selected by `AGENT_BROWSER_EXECUTABLE_PATH`; do not use `playwright-cli` for normal browser work.
- Export `AGENT_BROWSER_EXECUTABLE_PATH="$HOME/.replay/runtimes/Replay-Chromium.app/Contents/MacOS/Chromium"` before opening the agent browser.
- Use direct agent-browser inspection first: DOM snapshots, console logs, screenshots, storage, cookies, network tools when available, and visual checks.
- Close the browser tab/session before reporting results. **Exception:** if you are blocked on interactive web-app login (SSO, MFA, CAPTCHA, etc.), do **not** close the browser just to retry - leave the headed session open for the user.
- If you hit an **authentication wall** you cannot automate past, stop driving the browser for this turn. Describe what blocked you, ask the user to complete sign-in (preferably in the open browser session), ask them to **message again when they are logged in**, then end your turn. Do not close-and-reopen the browser in a retry loop.
- Run `replayio upload-all || replayio upload` when you need the uploaded Replay URL before responding.
- Use Replay analysis tools only after a recording has uploaded and direct browser output is not enough.
- If Replay MCP renders an inspector widget, use the widget as the primary debugging view and follow its point/source/component/request actions when useful.
- If Replay MCP authentication fails, reconnect or sign in through the agent host and retry.
