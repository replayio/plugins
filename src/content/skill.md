---
name: "replayio"
description: "Use when you need to record or inspect a Playwright CLI browser run in Replay, test a local app directly with Playwright CLI, or use {{ANALYSIS_SURFACE}} for deeper debugging of an uploaded recording."
---

# Replay Browser + Playwright CLI + {{TITLE_SUFFIX}}

{{AGENT_BROWSER_WARNING}}Use `playwright-cli` with the Replay Browser whenever you need a recorded browser session. Recordings upload automatically — you do **not** need to run `replayio upload` yourself. Your only responsibility is to **close the browser when the test is complete**. The plugin's hooks handle the rest:

- **Close hook**: when you run a `playwright-cli close`, pending recordings upload immediately.
- **Stop/idle hook**: when your agent turn ends or idles, any still-open browser is closed and pending recordings upload as a safety net.

Always prefer closing explicitly — it gives faster feedback and ensures recordings finish writing before you report results.

## Direct CLI first

Use `playwright-cli` directly for live browser control and first-pass inspection. Do not reach for {{ANALYSIS_SURFACE}} just to click, type, snapshot, read console output, inspect network requests, take screenshots, read storage, or check cookies.

Use {{ANALYSIS_SURFACE}} only after a recording has uploaded and you need deeper Replay-specific debugging, such as inspecting execution history, narrowing a time-travel debugging problem, or investigating details that the live CLI cannot answer.

Useful direct commands:

```bash
"$PWCLI" --session="$SESSION" snapshot
"$PWCLI" --session="$SESSION" console
"$PWCLI" --session="$SESSION" console error
"$PWCLI" --session="$SESSION" network
"$PWCLI" --session="$SESSION" screenshot output/playwright/$SESSION/page.png
"$PWCLI" --session="$SESSION" eval "document.title"
"$PWCLI" --session="$SESSION" localstorage-list
"$PWCLI" --session="$SESSION" sessionstorage-list
"$PWCLI" --session="$SESSION" cookie-list
```

## Close-when-done contract

After you finish a test run, **before reporting the outcome to the user**, close the browser:

```bash
"$PWCLI" --session="$SESSION" close
```

Do not leave a browser open at the end of your turn. If you forget, the stop/idle hook will clean up, but you may not see the resulting Replay URL before responding.

## The reliable path

1. Verify `npx` exists.
2. Verify the Replay runtime exists and the CLI is logged in.
3. Verify `.playwright/cli.config.json` points at the Replay Chromium binary.
4. Set both `RECORD_ALL_CONTENT='1'` and `RECORD_REPLAY_VERBOSE='1'`.
5. If testing a local app, start it first and verify the actual reachable URL.
6. Use `--session=<short-name>`, not `-s=...`.
7. Keep session names short on macOS. Long names can fail with `listen EINVAL ... .sock`.
8. Drive and inspect the page directly with `playwright-cli` commands.
9. Close the browser with `"$PWCLI" --session="$SESSION" close` when done — uploads happen automatically.

## Prerequisites

Check `npx` first:

```bash
command -v npx >/dev/null 2>&1
```

If missing, stop and ask the user to install Node.js/npm.

## Replay MCP authentication (required for private recordings)

Replay MCP needs an API key to access private recordings. Ensure the MCP server config includes an `Authorization` header.

- Generate an API key from Replay (see Replay docs).
- Set `REPLAY_API_KEY` in the environment where Cursor runs, or set the header directly in Cursor’s MCP server config.

## Replay setup

Do not blindly reinstall Replay on every run. Verify first.

```bash
replayio info
replayio whoami
```

If Replay is missing, install it:

```bash
npx @replayio/replay install
```

If not logged in, authenticate:

```bash
replayio login
```

## Playwright CLI config

`playwright-cli` should use the Replay Browser through `.playwright/cli.config.json`:

```json
{
  "browser": {
    "launchOptions": {
      "executablePath": "/Users/YOURUSERNAME/.replay/runtimes/Replay-Chromium.app/Contents/MacOS/Chromium"
    }
  }
}
```

Do not rely on a global `--executable-path` flag — the config file is the reliable way to select Replay Chromium.

## Skill path

The plugin ships a wrapper script so you can invoke `playwright-cli` without a global install:

```bash
export RECORD_ALL_CONTENT='1'
export RECORD_REPLAY_VERBOSE='1'
export PWCLI="{{PWCLI_EXPORT}}"
```

If the plugin root environment variable is not set, run from the generated plugin repo root or point `PWCLI` at the Replay plugin checkout.

## Local app check

If testing a local app:

1. Start the app first.
2. Use the URL the dev server actually prints.
3. Do not assume the requested port is the final port. Some dev servers auto-increment when the port is busy.
4. Verify reachability before opening the browser.

```bash
curl -I http://127.0.0.1:4323/todos
```

If a localhost request fails even though a process is clearly listening, you may be in a restricted sandbox. Rerun the browser and reachability checks outside the sandbox.

## Reliable session workflow

```bash
SESSION=rt
URL=http://127.0.0.1:4323/todos
mkdir -p "output/playwright/$SESSION"

"$PWCLI" --session="$SESSION" open "$URL" --headed --browser=chrome
# wait for: Browser `rt` opened with pid ...

"$PWCLI" --session="$SESSION" snapshot
"$PWCLI" --session="$SESSION" fill e6 "Buy milk"
"$PWCLI" --session="$SESSION" click e7
"$PWCLI" --session="$SESSION" snapshot
"$PWCLI" --session="$SESSION" console error
"$PWCLI" --session="$SESSION" screenshot output/playwright/$SESSION/after-add.png

# When the test is complete, close the browser.
# The upload hook will upload the recording automatically.
"$PWCLI" --session="$SESSION" close
```

Use `snapshot` before using element refs, and again after DOM changes or navigation.

## Attach to an already-open browser

If the browser is already running:

```bash
"$PWCLI" list
"$PWCLI" attach rt --session=rt1
"$PWCLI" --session=rt1 snapshot
```

## Analyzing uploaded recordings

First inspect the live run with direct `playwright-cli` commands. Once a recording has uploaded, use {{ANALYSIS_TOOLS}} only when you need deeper Replay-specific debugging beyond direct CLI output. {{AUTH_NOTE}}

## Recording uploads are automatic

You do **not** need to run `replayio list` or `replayio upload <id>` manually. The plugin's hooks handle uploads:

- When you close a session (`"$PWCLI" --session=... close`), the close hook uploads any new recordings.
- When your turn ends or idles with a browser still open, the stop/idle hook closes the session and uploads.

If you need to inspect the upload state yourself:

```bash
replayio list
```

## Troubleshooting

- If `open` appears stuck, wait for the browser-opened output before sending the next command.
- If `snapshot` says the browser is not open, retry with `--session=<name>` instead of `-s=...`.
- If you see `listen EINVAL ... .sock`, shorten the session name.
- If the app is on localhost, verify the exact URL with `curl -I` before opening the browser.
- If the requested port was busy, use the actual port printed by the dev server.
- If a browser exists but your commands are detached, use `list` then `attach`.
- Prefer explicit commands like `fill`, `click`, `check`, and `press` over `eval` or `run-code`.
- Prefer direct CLI inspection (`console`, `network`, `screenshot`, storage, cookies, `eval`) before using {{ANALYSIS_SURFACE}}.
- If Replay authentication fails, run `replayio login` or reconnect the relevant Replay app/integration.

## References

- CLI command reference: `references/cli.md`
- Workflow notes: `references/workflows.md`
- [Replay docs](https://docs.replay.io)
