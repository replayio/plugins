# Agent Browser Reference

Configure the browser executable before opening the host agent browser:

```bash
export AGENT_BROWSER_EXECUTABLE_PATH="$HOME/.replay/runtimes/Replay-Chromium.app/Contents/MacOS/Chromium"
export RECORD_ALL_CONTENT='1'
export RECORD_REPLAY_VERBOSE='1'
```

Use the host agent browser or browser tool directly for Replay-first browser work, with Replay Chromium selected by `AGENT_BROWSER_EXECUTABLE_PATH`. Use `playwright-cli` when the run needs an MP4 artifact or the host workflow specifically requires CLI-driven browser control.

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

After closing the tab/session, manually upload pending recordings before reporting results:

```bash
replayio upload-all || replayio upload
```

## MP4 Recording With playwright-cli

Start video before meaningful interaction:

```bash
VIDEO_PATH="$(pwd)/tmp/recordings/browser-run/browser-run.mp4"
mkdir -p "$(dirname "$VIDEO_PATH")"
npx --yes --package @playwright/cli playwright-cli open "$URL"
npx --yes --package @playwright/cli playwright-cli video-start "$VIDEO_PATH" --size 1280x720
npx --yes --package @playwright/cli playwright-cli video-show-actions --duration 750 --position top-right
```

Stop and verify video before reporting:

```bash
npx --yes --package @playwright/cli playwright-cli video-stop
npx --yes --package @playwright/cli playwright-cli close
test -f "$VIDEO_PATH"
```

Always embed generated MP4 files in the final response with Markdown image syntax:

```markdown
![video](/absolute/path/to/recording.mp4)
```

## Inspection

Use direct agent-browser inspection before reaching for Replay analysis tools:

- DOM snapshots for locator ground truth.
- Console and developer logs from the browser API.
- Screenshots for visual state.
- Read-only page evaluation for state such as title, URL, local storage, and session storage.
- Host-provided network and cookie tools when available.

Use Replay analysis tools only after the recording has uploaded and direct browser output is not enough to explain the issue.
