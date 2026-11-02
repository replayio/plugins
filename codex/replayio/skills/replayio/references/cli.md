# Agent Browser Reference

Configure the browser executable before opening the host agent browser:

```bash
export AGENT_BROWSER_EXECUTABLE_PATH="$HOME/.replay/runtimes/Replay-Chromium.app/Contents/MacOS/Chromium"
export AGENT_BROWSER_PROFILE="${AGENT_BROWSER_PROFILE:-Default}"
export RECORD_ALL_CONTENT='1'
export RECORD_REPLAY_VERBOSE='1'
```

`AGENT_BROWSER_PROFILE` tells agent-browser to copy login state from the main Chrome profile into a temporary Replay Chromium profile. `Default` is the normal default; run `agent-browser profiles` and set a different display or directory name when needed. The source Chrome profile is never modified, and the temporary copy is deleted when the Replay browser closes. Omit the profile setting when a clean unauthenticated session is required.

Use agent-browser directly, or the packaged scripts for JSON output. `browser-open.js` opens the URL in Replay Chromium and starts the rrweb recording; `browser-close.js` closes the browser, finishes its `.rrweb` file, and uploads its Replay recordings. Any `agent-browser` command is recorded either way.

## Basics

The exact API is host-specific. In Browser-plugin hosts, use the selected `iab` browser:

```js
await browser.nameSession("replay run");
if (typeof tab === "undefined") {
  globalThis.tab = await browser.tabs.new();
}
await tab.goto("https://example.com");
console.log(await tab.playwright.domSnapshot());
await nodeRepl.emitImage(await tab.screenshot({ fullPage: false }));
await tab.close();
```

When the browser work is done, close through the lifecycle script:

```bash
node "$SCRIPT_DIR/browser-close.js"
```

## rrweb Recordings

Each session streams to `~/.replay/rrweb/recordings/<time>-<session>-<id>.rrweb` as it runs: one JSON value per line, rrweb events verbatim alongside the recorder's own lines (`header`, `feed`, `replay`, `end`). To get a plain rrweb event array:

```bash
jq -s 'map(select(.type | numbers))' file.rrweb > events.json
```

Watch recordings in any browser. The viewer streams one live while it is being made and plays it with a seek bar once it has ended:

```bash
node "$SCRIPT_DIR/../live/rrweb.mjs" list                   # every recording, newest first, with its file
node "$SCRIPT_DIR/../live/rrweb.mjs" play latest            # or a session name, a recording id, or a path to a .rrweb file
```

`play` opens the viewer and prints its `viewer_url`. Give the person that URL when they should watch a run. It works on this machine only.

Replay upload is separate from the rrweb file. If `browser-close.js` reports `upload_error`, the file is still complete; report the upload failure separately.

## Worker/Critic Prompt Templates

The Pro bundle includes reusable prompt templates for a Replay proof loop:

```bash
WORKER_PROMPT="$SKILL_DIR/subagents/replay-worker.md"
CRITIC_PROMPT="$SKILL_DIR/subagents/replay-critic.md"
```

Use the worker prompt for the implementation subagent that edits code and records the final session. Use the critic prompt for the read-only subagent that inspects the uploaded Replay recording against the requirements and diff. The critic should use Replay MCP only; it should not run shell commands, edit files, or open a fresh browser.

## Multi-Session Output

For two browser sessions, name each session and pass that name to every command. Each gets its own `.rrweb` file and its own live stream:

```bash
node "$SCRIPT_DIR/browser-open.js" "$URL" --session "$RUN_ID-ada"
node "$SCRIPT_DIR/browser-open.js" "$URL" --session "$RUN_ID-linus"
agent-browser --session "$RUN_ID-ada" snapshot
agent-browser --session "$RUN_ID-linus" snapshot
node "$SCRIPT_DIR/browser-close.js" --session "$RUN_ID-ada"
node "$SCRIPT_DIR/browser-close.js" --session "$RUN_ID-linus"
```

## `jq` Filtering For Uploads

If `jq` is missing, install it first:

```bash
brew install jq
# or: sudo apt update && sudo apt install jq
# or: winget install jqlang.jq
```

Use `jq` to upload only finished recordings from the current run:

```bash
mapfile -t replay_ids < <(
  replayio list --json | jq -r --arg started "$STARTED_AT" --arg room "$ROOM" '
    .[]
    | select(.date >= $started)
    | select((.metadata.uri // "" | contains($room)) or (.metadata.title // "" | contains($room)))
    | select(.recordingStatus == "finished")
    | select((.uploadStatus // "not_uploaded") != "uploaded")
    | .id
  '
)

[ "${#replay_ids[@]}" -gt 0 ] && replayio upload "${replay_ids[@]}"
```

Before testing auth/backend-dependent local app behavior, choose with the user whether to run as-is or with emulation. Recommend emulation when login, checkout, email, database, OAuth, or API behavior depends on services that are absent in the local run. If the user chooses as-is, label missing login/chat redirects as local as-run behavior rather than production-auth bugs.

## Inspection

Use direct agent-browser inspection before reaching for Replay analysis tools:

- DOM snapshots for locator ground truth.
- Console and developer logs from the browser API.
- Screenshots for visual state.
- Read-only page evaluation for state such as title, URL, local storage, and session storage.
- Host-provided network and cookie tools when available.

Use Replay analysis tools only after the recording has uploaded and direct browser output is not enough to explain the issue.
