# Agent Browser Workflows

Use the host agent browser with Replay Chromium selected by `AGENT_BROWSER_EXECUTABLE_PATH` for Replay-first work. Use `playwright-cli` when the run needs an MP4 browser recording.

## Standard Interaction Loop

```bash
export AGENT_BROWSER_EXECUTABLE_PATH="$HOME/.replay/runtimes/Replay-Chromium.app/Contents/MacOS/Chromium"
export RECORD_ALL_CONTENT='1'
export RECORD_REPLAY_VERBOSE='1'
```

Then drive the browser through the host browser API:

1. Open the target URL in the agent browser.
2. Take a DOM snapshot or screenshot.
3. Interact with stable locators or visible UI.
4. Re-snapshot after DOM changes or navigation.
5. Close the tab/session when done.
6. Run `replayio upload-all || replayio upload` before reporting.

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

## Playwright CLI MP4 Loop

```bash
VIDEO_PATH="$(pwd)/tmp/recordings/browser-run/browser-run.mp4"
mkdir -p "$(dirname "$VIDEO_PATH")"
npx --yes --package @playwright/cli playwright-cli open "$URL"
npx --yes --package @playwright/cli playwright-cli video-start "$VIDEO_PATH" --size 1280x720
npx --yes --package @playwright/cli playwright-cli video-show-actions --duration 750 --position top-right
```

Use `playwright-cli` interaction, inspection, and chapter commands during the run:

```bash
npx --yes --package @playwright/cli playwright-cli video-chapter "Checkout flow"
npx --yes --package @playwright/cli playwright-cli snapshot
```

Before responding:

```bash
npx --yes --package @playwright/cli playwright-cli video-stop
npx --yes --package @playwright/cli playwright-cli close
test -f "$VIDEO_PATH"
```

Embed the video directly in the response:

```markdown
![video](/absolute/path/to/browser-run.mp4)
```
