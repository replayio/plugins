# Agent Browser Reference

Configure the browser executable before opening the host agent browser:

```bash
export AGENT_BROWSER_EXECUTABLE_PATH="$HOME/.replay/runtimes/Replay-Chromium.app/Contents/MacOS/Chromium"
export RECORD_ALL_CONTENT='1'
export RECORD_REPLAY_VERBOSE='1'
```

Use the packaged browser lifecycle scripts for Replay-first browser work. `browser-open.js` opens the browser with Replay recording flags and starts WebM screencast capture; `browser-close.js` stops capture, closes the browser, transcodes WebM to MP4 with ffmpeg, verifies MP4 output, and uploads pending Replay recordings.

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

## MP4 Recording With Screencast And ffmpeg

Open the browser before meaningful interaction:

```bash
VIDEO_PATH="$(pwd)/tmp/recordings/browser-run/browser-run.mp4"
node "$SCRIPT_DIR/browser-open.js" "$URL" --output "$VIDEO_PATH"
```

Close, stop capture, synchronously transcode to MP4, verify video, and upload Replay recordings before reporting:

```bash
node "$SCRIPT_DIR/browser-close.js" --output "$VIDEO_PATH"
```

Always embed generated MP4 files in the final response with Markdown image syntax:

```markdown
![video](/absolute/path/to/recording.mp4)
```

Do not use Playwright BrowserContext `recordVideo` for requested MP4 evidence. It can produce WebM. The lifecycle scripts intentionally capture WebM internally, then `browser-close.js` waits for capture stop and ffmpeg to finish before returning a verified MP4. Do not embed a WebM or rename WebM to `.mp4`.

If ffmpeg is missing, install it and rerun:

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

The raw-frame screencast route with `onFrame` can feed frames into ffmpeg for custom streaming encoders, but the final video is still only safe to embed after the ffmpeg process exits successfully.

## Inspection

Use direct agent-browser inspection before reaching for Replay analysis tools:

- DOM snapshots for locator ground truth.
- Console and developer logs from the browser API.
- Screenshots for visual state.
- Read-only page evaluation for state such as title, URL, local storage, and session storage.
- Host-provided network and cookie tools when available.

Use Replay analysis tools only after the recording has uploaded and direct browser output is not enough to explain the issue.
