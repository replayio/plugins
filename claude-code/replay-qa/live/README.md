# Replay QA live views

Replay QA runs its browsers in the cloud. This folder streams what they do into Claude Code:

- **Inline players.** Start an exploration, re-test a bug fix, or report a missed bug from the
  agent and the result of that call becomes a live rrweb player: the page as the QA agent sees
  it, with its narration, streaming while it runs and scrubbable once it ends.
- **A canvas.** `/replayqa canvas` opens every journey of the project as a grid of rrweb players.
  Running explorations and journey runs stream live, in parallel; finished journeys show their
  latest run. A finished tile shows the run's last frame: the QA API keeps no screenshot, so the
  relay draws one per run, once, and keeps it in `thumbs/`.
  Every tile with a recording has playback controls: ▶/❚❚, a timeline to press or drag (the tile shows
  that moment, and the screencast with it), the time, and **● Live** to follow a running recording again.
  Only running tiles have a player from the start; a finished one shows its thumbnail under placeholder
  controls and gets a player the first time they are used, which then plays or shows the moment pressed.
  The same canvas opens in a browser tab, where it pans and zooms: pinch or Ctrl/⌘-scroll to zoom,
  scroll or drag to pan, double-click a tile to focus it, `0` to fit.
  In the terminal the pane's picture is that canvas alone, sized to the pane: scroll over it to zoom
  around the pointer, drag to pan, double-click a tile to focus it, use the footer's
  `−` `100%` `+` `Fit` buttons, or once clicked `+` `-` `0` `1` and the arrows. Both views have a
  minimap in the corner (tiles in their status colours, the view outlined): press or drag on it to
  move the view there. A press or drag is sent whole to the page (`gesture`), which decides from
  where it began whether it scrubs, presses a button or pans. `hooks/camera.tsx` turns those into the
  relay's `/canvas/:project/camera` moves, which it runs in the screencast page.

## How it works

1. `hooks/register.tsx` (a Claude Code hooks module, listed under `modules` in `hooks/hooks.json`)
   starts `live/relay.mjs`, a zero-dependency Node server on 127.0.0.1 with a random port and token.
2. When a `replayqa` command starts work, the relay is told to *follow* the project. It runs
   `replayqa recording-events` for every exploration, test run and task that is running, until the
   project's status says it is done, and keeps the rrweb events in
   memory and in `~/.claude/replay-qa-live/recordings/*.ndjson`, so a finished run is only fetched once.
3. `player.html` plays one recording with rrweb's `Replayer`; `canvas.html` lays out many of them.
   The relay renders either in headless Replay Chromium and screencasts PNG frames, which the hooks
   module draws as an `Image` in the conversation.

`recording-events` owns what the API makes necessary: pages over its 6 MB limit are fetched smaller, and events too big for one row are joined back together. The CLI is pinned in `relay.mjs`, so a release cannot change this stream by itself. The relay still calls the API itself for the project overview it polls, as starting a process for each poll would be too slow.

A project on another QA server (a PR preview, staging) is read from that server. The relay takes it
from a running tunnel (`replayqa proxy|run --project <id> --qa-url <url>`, the command the server's own
reverse-proxy runbook prints), or from what the hooks module saw: a dashboard URL given to
`/replayqa canvas <url>`, `REPLAY_QA_API_BASE` or `REPLAY_QA_URL` on a command, `--qa-url` in a
command's output, or `proxy.qa-url` in `.replay/config.json`. It remembers each in `servers.json`; anything
else uses `REPLAY_QA_API_BASE`, `REPLAY_QA_URL` or qa.replay.io. Recordings use the CLI's authentication; the overview reads the same sources (`REPLAY_QA_API_KEY`,
`REPLAY_API_KEY`, `REPLAY_ACCESS_TOKEN`, or `~/.replay/profile/auth.json`).

## Requirements

- A Claude Code build with function hooks, enabled with `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1`.
- A terminal with the kitty graphics protocol (Ghostty, kitty) for the inline picture. Elsewhere the
  row shows its controls and **Open in browser**.
- Replay Chromium (`npx @replayio/replay install`) for the headless renderer (`REPLAY_LIVE_CHROME`
  points at another Chromium-based browser).

## Development

```bash
npm test         # the relay, against a mock of the QA API; REPLAY_QA_CLI="node /path/to/replayqa-cli/bin.js" uses a checkout of the CLI
npm run demo     # the mock API and the relay; prints a canvas URL to open in a browser
```

`test/mock-qa-api.mjs` serves the same response shapes as the real API, with its size cap and chunking,
and runs that reveal their events over time, so nothing here spends QA credits.
