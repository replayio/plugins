# Agent Browser Workflows

Use the packaged browser lifecycle scripts for Replay-first work. `browser-open.js` opens the browser with Replay recording flags and starts WebM screencast capture; `browser-close.js` stops capture, closes the browser, transcodes WebM to MP4 with ffmpeg, verifies MP4 output, and uploads pending Replay recordings.

## Standard Interaction Loop

```bash
export AGENT_BROWSER_EXECUTABLE_PATH="$HOME/.replay/runtimes/Replay-Chromium.app/Contents/MacOS/Chromium"
export RECORD_ALL_CONTENT='1'
export RECORD_REPLAY_VERBOSE='1'
```

Then drive the browser through the host browser API:

1. Open the target URL with `browser-open.js`.
2. Take a DOM snapshot or screenshot.
3. Interact with stable locators or visible UI.
4. Re-snapshot after DOM changes or navigation.
5. Close with `browser-close.js` when done; it must finish successfully before embedding video because it waits for ffmpeg to write the MP4.
6. Use the Codex stop hook only as a cleanup safety net.

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

## Screencast MP4 Loop

```bash
VIDEO_PATH="$(pwd)/tmp/recordings/browser-run/browser-run.mp4"
node "$SCRIPT_DIR/browser-open.js" "$URL" --output "$VIDEO_PATH"
```

Use `playwright-cli` interaction, inspection, and chapter commands during the run:

```bash
npx --yes --package @playwright/cli playwright-cli video-chapter "Checkout flow"
npx --yes --package @playwright/cli playwright-cli snapshot
```

Before responding:

```bash
node "$SCRIPT_DIR/browser-close.js" --output "$VIDEO_PATH"
```

Embed the video directly in the response:

```markdown
![video](/absolute/path/to/browser-run.mp4)
```

Internally, capture is WebM. The MP4 exists only after `browser-close.js` stops capture and ffmpeg exits successfully. If ffmpeg is missing, install it and rerun:

```bash
# macOS
brew install ffmpeg

# Ubuntu/Debian
sudo apt update && sudo apt install ffmpeg

# Windows
winget install Gyan.FFmpeg
# or: choco install ffmpeg
```

Use the raw-frame `onFrame` screencast path only when a task specifically needs live custom encoding. Even then, close the encoder stream and wait for the ffmpeg process to exit before reporting the final MP4.
