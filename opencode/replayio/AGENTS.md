# Replay.io Plugin Guidance

Use the Replay browser workflow when a task needs a recorded browser session.

- Prefer the host agent browser with Replay Chromium selected by `AGENT_BROWSER_EXECUTABLE_PATH`; do not use `playwright-cli` for normal browser work.
- Export `AGENT_BROWSER_EXECUTABLE_PATH="$HOME/.replay/runtimes/Replay-Chromium.app/Contents/MacOS/Chromium"` before opening the agent browser.
- Export `AGENT_BROWSER_PROFILE="${AGENT_BROWSER_PROFILE:-Default}"` so agent-browser copies the main Chrome profile's cookies and storage into a temporary Replay Chromium profile. Run `agent-browser profiles` and override the name when needed. The source stays read-only and the temporary copy is deleted on close; omit this setting for a clean unauthenticated run.
- Use direct agent-browser inspection first: DOM snapshots, console logs, screenshots, storage, cookies, network tools when available, and visual checks.
- Close the browser tab/session before reporting results. **Exception:** if you are blocked on interactive web-app login (SSO, MFA, CAPTCHA, etc.), do **not** close the browser just to retry - leave the headed session open for the user.
- If you hit an **authentication wall** you cannot automate past, stop driving the browser for this turn. Describe what blocked you, ask the user to complete sign-in (preferably in the open browser session), ask them to **message again when they are logged in**, then end your turn. Do not close-and-reopen the browser in a retry loop.
- Every `agent-browser` session is recorded as an rrweb stream to `~/.replay/rrweb/recordings/*.rrweb`. Run `node .opencode/replayio-live/rrweb.mjs play latest` (or a session name, recording id, or `.rrweb` path) for a viewer that streams it live or plays it afterwards, and `list` for all of them. Files stay on this machine; with a Chrome profile imported they include logged-in content.
- Run `replayio upload-all || replayio upload` when you need the uploaded Replay URL before responding.
- Use Replay analysis tools only after a recording has uploaded and direct browser output is not enough.
- If Replay MCP renders an inspector widget, use the widget as the primary debugging view and follow its point/source/component/request actions when useful.
- If Replay MCP authentication fails, reconnect or sign in through the agent host and retry.
- For Replay-backed proof work, use the OpenCode subagents in `.opencode/agent/replay-worker.md` and `.opencode/agent/replay-critic.md`.
- Keep the worker and critic separate: the worker may edit code and record the final session; the critic reviews only the uploaded Replay recording and supplied diff, and should not edit files, run shell commands, or drive a fresh browser.
- Loop on critic verdicts: `needs_revision` means change code and record again, `needs_evidence` means re-record the missing path, and `satisfied` means the proof can be reported.
