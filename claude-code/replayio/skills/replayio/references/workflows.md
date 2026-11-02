# Agent Browser Workflows

Use agent-browser with Replay Chromium for Replay-first work. Every session is recorded as an rrweb stream to a `.rrweb` file, watchable live and afterwards. `browser-open.js` and `browser-close.js` wrap the open and close with JSON output; `browser-close.js` also uploads the session's Replay recordings.

## Standard Interaction Loop

```bash
export AGENT_BROWSER_EXECUTABLE_PATH="$HOME/.replay/runtimes/Replay-Chromium.app/Contents/MacOS/Chromium"
export AGENT_BROWSER_PROFILE="${AGENT_BROWSER_PROFILE:-Default}"
export RECORD_ALL_CONTENT='1'
export RECORD_REPLAY_VERBOSE='1'
```

Then drive the browser through the host browser API:

1. Open the target URL with `browser-open.js` and keep the returned `agent_browser_session`.
2. Take a DOM snapshot or screenshot.
3. Interact with stable locators or visible UI, passing `--session "$SESSION"` to each `agent-browser` command.
4. Re-snapshot after DOM changes or navigation.
5. Close with `browser-close.js` when done; the recording finishes then, and it reports the `.rrweb` file and the Replay URLs.
6. Use the Claude Code stop hook only as a cleanup safety net.

## Debugging And Inspection

Capture console messages and visual state after reproducing an issue. In Browser-plugin hosts:

```js
console.log(await tab.playwright.domSnapshot());
console.log(await tab.dev.logs({ levels: ["error", "warn"], limit: 100 }));
await nodeRepl.emitImage(await tab.screenshot({ fullPage: false }));
console.log(await tab.playwright.evaluate(() => ({
  href: location.href,
  title: document.title,
  localStorage: { ...localStorage },
  sessionStorage: { ...sessionStorage },
})));
```

Use Replay analysis tools only after the recording has uploaded and direct browser output is not enough to explain the issue.

## Worker/Critic Proof Loop

For implementation tasks where Replay should prove the work, use the subagent prompt templates installed under `skills/replayio/subagents/`:

- `replay-worker.md`: builds or fixes the feature, self-validates with the browser, and records the final proof session under Replay Chromium.
- `replay-critic.md`: performs read-only adversarial review of the uploaded Replay recording against the requirements and supplied diff.

The critic must be a separate role from the worker whenever the host supports subagents. Give the critic only the requirements, worker claim, recording IDs/URLs, and diff. Do not give it file-write, shell, or live-browser authority. Its job is predict-then-verify runtime facts through Replay MCP, audit changed-code coverage, find mocks/fixtures that made the proof pass, and return `satisfied`, `needs_evidence`, or `needs_revision`.

Treat `needs_revision` as an implementation failure and send it back to the worker. Treat `needs_evidence` as a proof-session failure and re-record the missing behavior without unnecessary code churn. Only report completion after the critic is satisfied or after clearly explaining the remaining blocker.

## Live And Historical Streams

While a browser runs, its stream is live; once it closes, the same recording plays with a seek bar. `rrweb.mjs play` takes `latest`, a session name, a recording id, or the path of a `.rrweb` file and opens the viewer for it:

```bash
node "$SCRIPT_DIR/../live/rrweb.mjs" play latest
```

In Claude Code, prefer the `play_recording` tool, which draws the player in the conversation.

A Replay upload failure does not affect the `.rrweb` file. Report it separately.

Before recording auth/backend-dependent app behavior, elicit whether to test the app as-is or with emulation/mocks. Recommend emulation when missing local services would otherwise make login, checkout, email, database, OAuth, or API flows look broken for reasons unrelated to the UI under test.

## Purpose-Built `record:replay` Project Scripts

When the app needs emulators, seeded users, two browser sessions, or repeatable proof artifacts, add a project-local `record:replay` script instead of doing a one-off manual browser run. The script should start the emulator and app on explicit ports, wait for health, run a dedicated Replay Playwright config, poll `replayio list --json` until the new recordings are `finished`, upload only finished IDs, write `recordings/latest.json`, and stop every spawned process in `finally`.

Do not upload local IDs that still have `recordingStatus: "recording"`. Poll with a timeout and report stuck IDs separately. This avoids runs where one Replay URL is missing because the recording was uploaded too early.


For multi-browser runs, give each browser a stable session name and pass it to every `agent-browser` and `browser-close.js` command.

## `jq` For Replay Lists

Install `jq` if it is missing:

```bash
if ! command -v jq >/dev/null 2>&1; then
  brew install jq
  # or: sudo apt update && sudo apt install jq
  # or: winget install jqlang.jq
fi
```

Filter `replayio list --json` before upload:

```bash
replayio list --json | jq -r --arg started "$STARTED_AT" --arg room "$ROOM" '
  .[]
  | select(.date >= $started)
  | select((.metadata.uri // "" | contains($room)) or (.metadata.title // "" | contains($room)))
  | [.id, .recordingStatus, (.uploadStatus // "not_uploaded"), (.metadata.title // "")]
  | @tsv
'
```
