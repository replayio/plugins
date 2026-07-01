---
name: "replayio"
description: "Use when you need the direct Replay.io dev tools: record or inspect a Replay browser run, capture and embed a verified MP4 video, test a local app with Replay Chromium, or use the Replay MCP server for deeper debugging of an uploaded recording."
---

# Replay.io Pro Dev Tools

Use the bundled browser lifecycle scripts for Replay browser work. Opening the browser starts Replay recording flags and WebM screencast capture; closing the browser stops capture, transcodes the WebM to a verified MP4 with ffmpeg, and uploads pending Replay recordings. The Codex `Stop` hook also runs close/upload cleanup as a safety net when a turn ends.

This pro package owns video evidence and direct Replay.io MCP debugging. Replay QA project, bug, journey, and exploration workflows belong to the separate `replay-qa` / `codex` package.

## Script Path

Resolve the plugin script directory from the absolute path of this loaded skill:

```bash
SKILL_DIR="/absolute/path/to/skills/replayio"
PLUGIN_ROOT="$(cd "$SKILL_DIR/../.." && pwd)"
SCRIPT_DIR="$PLUGIN_ROOT/scripts"
```

When Codex lists this skill, use that listed filesystem path for `SKILL_DIR`. Do not guess a project-local path unless this package was installed into the current project.

Available scripts:

| Script | Purpose |
| --- | --- |
| `browser-open.js` | Open a URL with Replay recording flags enabled and start WebM capture for a final MP4 artifact. |
| `browser-close.js` | Stop capture, close the browser, transcode WebM to MP4 with ffmpeg, verify the MP4, and upload pending Replay recordings. |
| `replayio_browser_lifecycle_hook.sh` | Codex post-tool hook that starts capture after raw `playwright-cli open` and cleans up after raw close commands. |
| `close_browsers_and_upload.sh` | Codex stop hook that closes lingering sessions and uploads pending Replay recordings. |

Run the skill-level setup check first when setup is unknown:

```bash
node "$SKILL_DIR/scripts/context.js"
```

## MP4 Video Response Contract

Only embed videos from this pro package. The Replay QA package should not instruct agents to embed videos.

When the task needs shareable browser video, open and close the browser through the lifecycle scripts. Use an absolute `.mp4` path when you need a predictable artifact location:

```bash
VIDEO_PATH="$(pwd)/tmp/recordings/browser-run/browser-run.mp4"
node "$SCRIPT_DIR/browser-open.js" "$URL" --output "$VIDEO_PATH"
```

Interact through `playwright-cli` commands or the host's attached CLI session. When the browser work is done, close through the lifecycle script:

```bash
PLAYWRIGHT_SESSION="<playwright_session from browser-open.js output>"
npx --yes --package @playwright/cli playwright-cli -s="$PLAYWRIGHT_SESSION" snapshot
node "$SCRIPT_DIR/browser-close.js" --output "$VIDEO_PATH"
```

Embed the verified MP4 in the response using Markdown image syntax:

```markdown
![video](/absolute/path/to/browser-run.mp4)
```

Do not call separate MP4 start/stop commands in the normal flow. Browser open starts WebM capture for the final MP4 in a named Playwright CLI session; use the returned `playwright_session` with `playwright-cli -s="$PLAYWRIGHT_SESSION"` for every CLI interaction in that run. Browser close stops capture in that same session, waits for the capture file to be flushed, runs ffmpeg synchronously, and verifies the MP4 before returning. Do not use Playwright `recordVideo` / BrowserContext video output or native Chromium video artifacts for requested video evidence. Chromium-native Playwright video commonly produces `.webm`; do not rename WebM files to `.mp4`. If the lifecycle cannot produce a valid `.mp4`, say so explicitly and report the blocker.

Treat Replay upload as separate from local video creation. If `browser-close.js` returns a verified `video` object but the upload helper fails, the local MP4 is still valid and can be embedded; report the Replay upload failure separately.

## Screencast And MP4 Encoding

Playwright screencast/file capture writes WebM first. A call such as `await page.screencast.start({ path: "run.webm" })` does not make an MP4, and the final MP4 is not safe to embed until both of these have completed:

1. Capture has stopped and flushed, for example `await page.screencast.stop()` or the equivalent `playwright-cli video-stop`.
2. `ffmpeg` has exited successfully after transcoding the WebM into the requested `.mp4`.

`browser-close.js` enforces that order synchronously. When it returns successfully, the response includes a verified MP4 path that can be embedded. If it fails because ffmpeg is missing, install ffmpeg and rerun:

Do not be confused if a file ending in `.mp4` initially reports `video/webm`. `playwright-cli video-start` can write WebM bytes to whatever path it is given, including a requested `.mp4` path. That file is the capture source, not the final MP4. Prefer the lifecycle default, which writes the source to `*.capture.webm`. If a raw or older flow already wrote WebM bytes to the `.mp4` path, do not move the file or pass a separate source flag; just run:

```bash
node "$SCRIPT_DIR/browser-close.js" --output "$VIDEO_PATH"
```

`browser-close.js` will detect the WebM source at the output path, transcode it through ffmpeg, and overwrite the path with a verified MP4 only after the encode succeeds. It also auto-detects adjacent `*.capture.webm`, `*.source.webm`, and `*.webm` files with the same basename if an older run already moved the source aside.

```bash
# macOS
brew install ffmpeg

# Ubuntu/Debian
sudo apt update && sudo apt install ffmpeg

# Windows
winget install Gyan.FFmpeg
# or: choco install ffmpeg

ffmpeg -version
```

For custom encoders such as MP4/AV1, Playwright's raw-frame route can consume screencast frames with `onFrame` and feed them into ffmpeg or another encoder. That is useful for live streaming or specialized codecs, but the agent still must close the ffmpeg stdin/stream and wait for the encoder process to exit before embedding the file. Prefer the lifecycle scripts unless the task specifically requires live streamed encoding.

## Video Duration And Stale Frames

`browser-close.js` compresses stale visual time by default. It transcodes with ffmpeg's duplicate-frame removal filter:

```text
mpdecimate,setpts=(3*N)/(30*TB),fps=30
```

This removes near-identical frames and resets timestamps so idle waits do not turn into long static video segments. The default `stale-time-scale` is `3`, which makes the compressed video about 3x longer than the most aggressive duplicate-removal cadence and keeps UI state changes readable. Use this default for evidence videos unless the user explicitly needs real-time duration fidelity.

Tune or disable stale-frame compression only when needed:

```bash
# Keep real-time duration, including idle waits.
node "$SCRIPT_DIR/browser-close.js" --output "$VIDEO_PATH" --compress-stale false

# Tune output.
node "$SCRIPT_DIR/browser-close.js" --output "$VIDEO_PATH" --fps 24 --stale-time-scale 2 --crf 30 --preset veryfast
```

Environment equivalents are `REPLAYIO_COMPRESS_STALE_FRAMES=0`, `REPLAYIO_STALE_TIME_SCALE`, `REPLAYIO_MP4_FPS`, `REPLAYIO_MP4_CRF`, and `REPLAYIO_MP4_PRESET`.

The final answer should report when stale-frame compression was applied if duration or timing matters.

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

Use the browser API's Playwright/DOM/vision helpers for interaction when you are attached to the opened session. If MP4 evidence is needed, use the `browser-open.js` / `browser-close.js` lifecycle above instead of relying on screenshots alone.

## Close-When-Done Contract

After you finish a lifecycle-script browser run, **before reporting the outcome to the user**, close through `browser-close.js`. This stops capture, closes the browser, transcodes and verifies the MP4 artifact, and uploads pending Replay recordings:

```bash
node "$SCRIPT_DIR/browser-close.js"
```

For host agent-browser tabs not opened through `browser-open.js`, close the tab with the host browser API. The Codex `Stop` hook still attempts pending Replay uploads as a safety net, but video capture is only automatic for lifecycle-script browser sessions.

Do not leave a browser open at the end of your turn. If you forget, the Codex `Stop` hook attempts to stop capture, close lingering sessions, transcode video, and upload pending Replay recordings as a safety net. If you need the MP4 path or Replay upload result before responding, close explicitly with `browser-close.js`.

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
3. Set both `RECORD_ALL_CONTENT='1'` and `RECORD_REPLAY_VERBOSE='1'`.
4. If testing a local app, start it first and verify the actual reachable URL.
5. Open the browser with `browser-open.js`; this starts Replay recording flags and WebM capture for the final MP4 and returns `playwright_session`.
6. Use fresh DOM snapshots or screenshots after navigation and major UI changes. If using `playwright-cli`, pass `-s="$PLAYWRIGHT_SESSION"` on every command so you do not attach to a stale default session.
7. Close with `browser-close.js`; this stops capture in the named CLI session, closes the CLI browser, waits for ffmpeg to finish MP4 output, verifies the MP4, and uploads pending Replay recordings.
8. Let the Codex `Stop` hook run cleanup only as a safety net, not as the main way to get artifact paths.
9. Embed any verified MP4 generated by the run in the final response as `![video](/absolute/path/to/file.mp4)`.

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

Check ffmpeg before MP4 work:

```bash
ffmpeg -version
```

If ffmpeg is missing, install it:

```bash
# macOS
brew install ffmpeg

# Ubuntu/Debian
sudo apt update && sudo apt install ffmpeg

# Windows
winget install Gyan.FFmpeg
# or: choco install ffmpeg
```

## Replay MCP Authentication

Replay MCP calls are authorized per user. If tools return **Access denied**, you are usually not authenticated to Replay as the same account that owns the recording.

Stay on `https://dispatch.replay.io/mcp` unless Replay explicitly instructs you to use another endpoint.

## Agent Browser Executable Path

The agent browser should launch Replay Chromium through `AGENT_BROWSER_EXECUTABLE_PATH`:

```bash
export AGENT_BROWSER_EXECUTABLE_PATH="$HOME/.replay/runtimes/Replay-Chromium.app/Contents/MacOS/Chromium"
```

Verify the executable exists before browser work:

```bash
test -x "$AGENT_BROWSER_EXECUTABLE_PATH"
```

Do not switch back to `playwright-cli` just to select the browser executable. If the agent browser was already running before the environment variable was set, restart or reconnect the agent browser so it picks up the Replay Chromium path. Use `playwright-cli` intentionally when you need MP4 video commands.

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
- If no Replay URL is available before you respond, close the browser with `browser-close.js`; it uploads pending recordings.
- If an MP4 was requested but no `.mp4` exists, check the `browser-close.js` output and report the blocker if the file still was not produced.
- If `browser-close.js` says ffmpeg is missing, install ffmpeg with the command for the current OS and rerun the capture.
- If a pre-close `.mp4` path reports `video/webm`, that is expected intermediate capture output. Run `browser-close.js`; do not embed it yet.
- If `browser-close.js` returns a verified `video` object but upload failed, embed the local MP4 and report the upload failure separately.
- If the final post-close artifact is `.webm` or `browser-close.js` reports the output MIME as WebM, do not embed it. The lifecycle should transcode WebM to MP4; report the ffmpeg/transcode blocker instead of renaming the file.
- If the app is on localhost, verify the exact URL with `curl -I` before opening the browser.
- If the requested port was busy, use the actual port printed by the dev server.
- Prefer direct agent-browser inspection (DOM snapshots, console logs, screenshots, storage, cookies, network tools when available) before using the Replay MCP server.
- If Replay authentication fails, run `replayio login` or reconnect the relevant Replay app/integration.
- If the application under test requires interactive login, follow **Web App Authentication Walls** - do not close-and-retry the browser session in a loop.

## References

- Agent browser reference: `references/cli.md`
- Workflow notes: `references/workflows.md`
- [Replay docs](https://docs.replay.io)
