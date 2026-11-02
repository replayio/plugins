---
name: "replayio"
description: "Use when you need the direct Replay.io dev tools: record or inspect a Replay browser run, watch or replay its rrweb stream, test a local app with Replay Chromium, or use the Replay MCP server for deeper debugging of an uploaded recording."
---

# Replay.io Pro Dev Tools

Use agent-browser with Replay Chromium for Replay browser work. Every session is recorded as an rrweb stream to a `.rrweb` file, watchable live and afterwards. Closing the browser finishes the file and uploads its Replay recordings. The Codex `Stop` hook does the same as a safety net.

This pro package owns rrweb recordings and direct Replay.io MCP debugging. Replay QA project, bug, journey, and exploration workflows belong to the separate `replay-qa` / `codex` package.

## Script Path

Resolve the plugin script directory from the absolute path of this loaded skill:

```bash
SKILL_DIR="/absolute/path/to/skills/replayio"
PLUGIN_ROOT="$(cd "$SKILL_DIR/../.." && pwd)"
SCRIPT_DIR="$PLUGIN_ROOT/scripts"
SUBAGENT_DIR="$SKILL_DIR/subagents"
```

When Codex lists this skill, use that listed filesystem path for `SKILL_DIR`. Do not guess a project-local path unless this package was installed into the current project.

Available scripts:

| Script | Purpose |
| --- | --- |
| `browser-open.js` | Open a URL in Replay Chromium with agent-browser and record it. Prints `agent_browser_session`, `rrweb_file` and `viewer_url`. |
| `browser-close.js` | Close that browser, finish its `.rrweb` file, and upload its Replay recordings. |

`live/rrweb.mjs` under the plugin root lists and plays recordings. Codex's `PostToolUse` and `Stop` hooks call it, so raw `agent-browser` commands are recorded too.

Available subagent prompt templates:

| Prompt | Purpose |
| --- | --- |
| `subagents/replay-worker.md` | Implementation worker that builds, self-validates in the browser, and records the final proof session. |
| `subagents/replay-critic.md` | Read-only adversarial critic that inspects the Replay recording against requirements and diff evidence. |

Run the skill-level setup check first when setup is unknown:

```bash
node "$SKILL_DIR/scripts/context.js"
```

## Build-And-Falsify Subagents

Use the worker/critic loop when the user asks for Replay-backed proof, adversarial verification, "agents that prove their work", or a UI/code change whose browser behavior should be validated by runtime evidence.

Before spawning or simulating the loop, read both prompt templates from `"$SUBAGENT_DIR"`. The worker and critic must be separate roles:

1. Worker: edits code, runs normal checks, drives the app, and records the final happy-path-plus-edge-path walkthrough under Replay Chromium.
2. Critic: receives requirements, the worker claim, the uploaded recording IDs/URLs, and the PR diff as static input. It reviews only the evidence: Replay MCP plus the supplied diff. It must not edit files, run shell commands, or drive a fresh browser.

If the host has a real subagent or multi-agent tool, spawn the worker and critic with the matching prompt templates. If no subagent tool is available, run the roles sequentially in the main thread while preserving the critic's read-only constraints.

Loop on the critic verdict:

- `needs_revision`: send the finding back to the worker, change the implementation, record a new proof session, and re-run the critic.
- `needs_evidence`: keep the implementation, record a better session that exercises the missing path, and re-run the critic.
- `satisfied`: report the proof artifacts and any suite promotion recommendation.

The recording is the unit of evidence. A screenshot, DOM snapshot, local rrweb file, or passing self-check is useful supporting context, but the critic should treat the uploaded Replay timeline as the source of truth for runtime state, network requests, source execution, exceptions, and mock-data audit.

## rrweb Recordings

Every agent-browser session is recorded. The plugin's hook joins the browser over CDP, injects an rrweb recorder into each page, and appends the stream to a `.rrweb` file:

```text
~/.replay/rrweb/recordings/<time>-<session>-<id>.rrweb
```

The file holds one JSON value per line: a line whose `type` is a number is an rrweb event, verbatim, and one whose `type` is a string is the recorder's own (`header`, `feed`, `replay`, `end`). It grows as the browser runs, so it is complete up to the last event even if the browser crashes. `jq -s 'map(select(.type | numbers))' file.rrweb` turns one into a plain rrweb event array.

The recording captures what the pages showed, so with a Chrome profile imported it includes logged-in content. Password inputs are masked. Files are readable only by the current user and stay on this machine.

Watch recordings in any browser. The viewer streams one live while it is being made and plays it with a seek bar once it has ended:

```bash
node "$PLUGIN_ROOT/live/rrweb.mjs" list                   # every recording, newest first, with its file
node "$PLUGIN_ROOT/live/rrweb.mjs" play latest            # or a session name, a recording id, or a path to a .rrweb file
```

`play` opens the viewer and prints its `viewer_url`. Give the person that URL when they should watch a run. It works on this machine only.

## Purpose-Built `record:replay` Scripts

When a local app needs repeatable full-stack recording, add a project-specific `record:replay` script instead of driving ad hoc browser sessions. This is the right pattern when the app needs local emulators, seeded auth, a database/API service, or multiple browser sessions.

Build the app script around these parts:

1. Start the required emulator(s) and the app on explicit local ports.
2. Wait for the app health URL before opening browsers.
3. Use a fresh room/run id such as `replay-${Date.now()}` and pass it through env.
4. Run a dedicated Replay Playwright config with two workers/sessions.
5. List recordings before and after the run, then poll until the new recordings are `finished`.
6. Upload only `finished` recordings that are not already uploaded.
7. Write `recordings/latest.json` with the room, URLs, local IDs, and any upload warnings.
8. Stop the app and emulator processes in `finally`.

Do not upload a recording whose `recordingStatus` is still `recording`; this commonly produces missing Replay URLs or one-sided success. Poll `replayio list --json` until both target recordings are `finished`, with a bounded timeout. If one stays stuck, keep the local `.rrweb` file, report the stuck local ID, and do not pretend both Replay URLs are ready.

For multi-session recordings, name every session explicitly and close the same named session. Each gets its own `.rrweb` file:

```bash
node "$SCRIPT_DIR/browser-open.js" "$URL" --session "chat-ada-$RUN_ID"
node "$SCRIPT_DIR/browser-open.js" "$URL" --session "chat-linus-$RUN_ID"

agent-browser --session "chat-ada-$RUN_ID" snapshot
agent-browser --session "chat-linus-$RUN_ID" snapshot

node "$SCRIPT_DIR/browser-close.js" --session "chat-ada-$RUN_ID"
node "$SCRIPT_DIR/browser-close.js" --session "chat-linus-$RUN_ID"
```

Do not rely on the default session when more than one browser is open.

## Filtering Recordings With `jq`

Install `jq` when it is not present:

```bash
if ! command -v jq >/dev/null 2>&1; then
  # macOS
  brew install jq

  # Ubuntu/Debian
  # sudo apt update && sudo apt install jq

  # Windows
  # winget install jqlang.jq
fi
```

Use `jq` to keep `replayio list --json` output small and to avoid uploading the wrong recording:

```bash
STARTED_AT="2026-07-01T00:00:00.000Z"
ROOM="replay-123"

replayio list --json | jq -r --arg started "$STARTED_AT" --arg room "$ROOM" '
  .[]
  | select(.date >= $started)
  | select((.metadata.uri // "" | contains($room)) or (.metadata.title // "" | contains($room)))
  | [.id, .recordingStatus, (.uploadStatus // "not_uploaded"), (.metadata.title // ""), (.metadata.uri // "")]
  | @tsv
'
```

Upload only finished, not-yet-uploaded IDs:

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

if [ "${#replay_ids[@]}" -gt 0 ]; then
  replayio upload "${replay_ids[@]}"
fi
```

## Emulation Choice For App Behavior

Before judging login, checkout, email, database, OAuth/OIDC, payment, or other backend-dependent flows in a local app, decide whether the run is testing the app **as-is** or with **emulation**.

Recommend emulation when the local app appears to depend on services that are absent in the current run, including auth/session backends, databases, API routes, payment providers, email providers, object storage, or external OAuth. Also recommend emulation when a static prototype has a login form but no logged-in app route. In that case, a failed login redirect is evidence that the local/static app has no implemented auth flow, not proof that a production auth flow is broken.

When emulation would materially change the result, stop and elicit a real user choice before recording:

```text
This app has a login/backend-dependent flow. I can either:
1. Test the local app as-is and report missing auth/backend behavior.
2. Use emulation/mocks where possible so login can reach the intended logged-in state.

Which mode should I use for this run? Also say whether to remember that choice for this app.
```

If the user chooses as-is, label the findings as "as-run local behavior" and do not imply the app was tested with backend/auth emulation. If the user chooses emulation, implement or enable the smallest realistic emulation needed for the flow before recording, then explain what was emulated in the final result.

If the user explicitly asks to remember the choice, or answers that the choice should be remembered for that app, create a small memory note using the host's memory mechanism and include the app/repo path, chosen mode, date, and reason. In Codex memory-enabled hosts, write the note only through the allowed memory-update path; do not edit memory registry files directly.

## Direct Agent Browser First

Use the host agent browser directly for live browser control and first-pass inspection. Do not reach for the Replay MCP server just to click, type, read DOM state, inspect console output, check network requests, take screenshots, read storage, or check cookies.

Use the Replay MCP server only after a recording has uploaded and you need deeper Replay-specific debugging, such as inspecting execution history, narrowing a time-travel debugging problem, or investigating details that the live agent browser cannot answer.

In Browser-plugin hosts, follow the Browser skill and use the selected `iab` browser. Typical direct checks look like this:

```js
await browser.nameSession("replay repro");
if (typeof tab === "undefined") {
  globalThis.tab = await browser.tabs.new();
}
await tab.goto(URL);
console.log(await tab.playwright.domSnapshot());
console.log(await tab.title());
console.log(await tab.url());
console.log(await tab.dev.logs({ levels: ["error"], limit: 50 }));
await nodeRepl.emitImage(await tab.screenshot({ fullPage: false }));
```

Use the browser API's Playwright/DOM/vision helpers for interaction when you are attached to the opened session. Every session is recorded, so rely on its `.rrweb` file and Replay recording rather than screenshots alone.

## Close-When-Done Contract

After you finish a browser run, **before reporting the outcome to the user**, close through `browser-close.js`. This closes the browser, finishes its `.rrweb` file, and uploads its Replay recordings:

```bash
node "$SCRIPT_DIR/browser-close.js"
```

For host agent-browser tabs not opened through `browser-open.js`, close the tab with the host browser API. The Codex `Stop` hook still attempts pending Replay uploads as a safety net.

Do not leave a browser open at the end of your turn. If you forget, the Codex `Stop` hook closes this directory's recorded sessions and uploads their Replay recordings as a safety net. If you need the Replay URLs for your response, run `browser-close.js` yourself.

**Exception - authentication wall:** If you must stop because the user needs to sign in interactively, do not close the browser just to retry or reset. Leaving the session open preserves the headed window they should use; closing can end the recording before login is done.

## Web App Authentication Walls

If you hit a **login or authorization barrier** you cannot complete with automation alone - for example a sign-in page, SSO redirect, MFA step, CAPTCHA, or consent screen - **do not** close the browser and loop on reopen/retry. That drops useful context and trains failing retries.

Instead:

1. Stop driving the browser for this turn.
2. Briefly report what blocked you (URL or visible state).
3. Ask the user to complete sign-in in the existing headed browser session when that is possible (or give them the exact URL if they must use another window).
4. Ask them to send another message when they are logged in so you can attach to the same session or continue from an authenticated page.
5. End your turn there; resume only after they confirm.

Do not treat an auth wall as a generic error to brute-force by closing and reopening the Replay browser.

## The Reliable Path

1. Run `context.js` and verify Replay CLI, Replay Chromium, and recording flags.
2. Export `AGENT_BROWSER_EXECUTABLE_PATH` to Replay Chromium before opening the agent browser.
3. Export `AGENT_BROWSER_PROFILE="${AGENT_BROWSER_PROFILE:-Default}"` so agent-browser snapshots the main Chrome profile's cookies and storage into Replay Chromium. Use `agent-browser profiles` to select another profile when needed.
4. Set both `RECORD_ALL_CONTENT='1'` and `RECORD_REPLAY_VERBOSE='1'`.
5. If testing a local app, start it first and verify the actual reachable URL.
6. Open the browser with `browser-open.js`; this starts the rrweb recording and returns `agent_browser_session`, `rrweb_file` and `viewer_url`.
7. Use fresh DOM snapshots or screenshots after navigation and major UI changes, passing `--session "$SESSION"` on every `agent-browser` command so you do not attach to a stale default session.
8. Close with `browser-close.js`; this closes the browser, finishes the `.rrweb` file, and uploads its Replay recordings.
9. Let the Codex `Stop` hook run cleanup only as a safety net, not as the main way to get artifact paths.
10. Report the `.rrweb` file and the `viewer_url`, and any Replay URLs, in the final response.

## Prerequisites

Check Replay first:

```bash
replayio info
replayio whoami
```

If Replay is missing, verify `npx` exists:

```bash
command -v npx >/dev/null 2>&1
```

If `npx` is missing, stop and ask the user to install Node.js/npm. If `npx` exists, install Replay:

```bash
npx @replayio/replay install
```

If not logged in, authenticate:

```bash
replayio login
```

## Replay MCP Authentication

Replay MCP calls are authorized per user. If tools return **Access denied**, you are usually not authenticated to Replay as the same account that owns the recording.

Stay on `https://dispatch.replay.io/mcp` unless Replay explicitly instructs you to use another endpoint.

## Agent Browser Executable Path

The agent browser should launch Replay Chromium through `AGENT_BROWSER_EXECUTABLE_PATH`:

```bash
export AGENT_BROWSER_EXECUTABLE_PATH="$HOME/.replay/runtimes/Replay-Chromium.app/Contents/MacOS/Chromium"
export AGENT_BROWSER_PROFILE="${AGENT_BROWSER_PROFILE:-Default}"
```

The profile setting makes agent-browser copy a read-only snapshot of Chrome's `Default` profile into the Replay Chromium launch, including cookies and local storage. Run `agent-browser profiles` and override `AGENT_BROWSER_PROFILE` for another Chrome profile. The original profile is never modified and the temporary copy is deleted on browser close. Omit the setting for a clean unauthenticated run.

Verify the executable exists before browser work:

```bash
test -x "$AGENT_BROWSER_EXECUTABLE_PATH"
```

Do not switch back to `playwright-cli` just to select the browser executable. If the agent browser was already running before the environment variable was set, restart or reconnect the agent browser so it picks up the Replay Chromium path.

## Recording Environment

Set recording flags before the run:

```bash
export RECORD_ALL_CONTENT='1'
export RECORD_REPLAY_VERBOSE='1'
```

Set these explicitly before opening the agent browser.

## Local App Check

If testing a local app:

1. Start the app first.
2. Use the URL the dev server actually prints.
3. Do not assume the requested port is the final port. Some dev servers auto-increment when the port is busy.
4. Verify reachability before opening the browser.

```bash
curl -I http://127.0.0.1:4323/todos
```

If a localhost request fails even though a process is clearly listening, you may be in a restricted sandbox. Rerun the browser and reachability checks outside the sandbox.

## Analyzing Uploaded Recordings

First inspect the live run with direct agent-browser APIs. Once a recording has uploaded, use the `replay` MCP server tools only when you need deeper Replay-specific debugging beyond direct browser output. Codex connects to the Replay HTTP MCP server configured in `.mcp.json`; the connected Replay app id remains available in `.app.json` for app-level authentication and compatibility.

## Replay MCP Widgets

Replay MCP tool calls may return both text `content` for the model and `structuredContent` for an MCP Apps widget. In MCP Apps-aware hosts, prefer the rendered widget for dense debugging views such as Logpoint output, console output, React component trees, Redux actions, network details, screenshots, source code, profiles, and exception stacks.

When a widget is visible, use it as evidence instead of restating every detail in prose. Use follow-up actions or related Replay MCP tools when the widget points to a specific point, source, component, request, or stack frame that needs deeper inspection.

## Troubleshooting

- If the agent browser does not record, verify `AGENT_BROWSER_EXECUTABLE_PATH` points at Replay Chromium and restart/reconnect the agent browser after setting it.
- If `test -x "$AGENT_BROWSER_EXECUTABLE_PATH"` fails, run `npx @replayio/replay install` or fix the path.
- If no Replay URL is available before you respond, close the browser with `browser-close.js`; it uploads its recordings.
- If a recording has no events, or `browser-open.js` fails to attach, check `~/.replay/rrweb/relay.log`.
- If `browser-close.js` reports `upload_error`, the `.rrweb` file is still complete; report the upload failure separately.
- If the app is on localhost, verify the exact URL with `curl -I` before opening the browser.
- If the requested port was busy, use the actual port printed by the dev server.
- Prefer direct agent-browser inspection (DOM snapshots, console logs, screenshots, storage, cookies, network tools when available) before using the Replay MCP server.
- If Replay authentication fails, run `replayio login` or reconnect the relevant Replay app/integration.
- If the application under test requires interactive login, follow **Web App Authentication Walls** - do not close-and-retry the browser session in a loop.

## References

- Agent browser reference: `references/cli.md`
- Workflow notes: `references/workflows.md`
- [Replay docs](https://docs.replay.io)
