# Agent Browser Workflows

Use the host agent browser with Replay Chromium selected by `AGENT_BROWSER_EXECUTABLE_PATH`.

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
6. Run `replayio upload-all || replayio upload` if you need the Replay URL before reporting.

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

For implementation tasks where Replay should prove the work, use the prompt templates installed under `skills/replayio/subagents/`:

- `replay-worker.md`: builds or fixes the feature, self-validates with the browser, and records the final proof session under Replay Chromium.
- `replay-critic.md`: performs read-only adversarial review of the uploaded Replay recording against the requirements and supplied diff.

The critic must be a separate role from the worker whenever the host supports subagents. Give the critic only the requirements, worker claim, recording IDs/URLs, and diff. Do not give it file-write, shell, or live-browser authority. Its job is predict-then-verify runtime facts through Replay MCP, audit changed-code coverage, find mocks/fixtures that made the proof pass, and return `satisfied`, `needs_evidence`, or `needs_revision`.

Treat `needs_revision` as an implementation failure and send it back to the worker. Treat `needs_evidence` as a proof-session failure and re-record the missing behavior without unnecessary code churn. Only report completion after the critic is satisfied or after clearly explaining the remaining blocker.
