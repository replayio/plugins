# Inline Replay players

When Claude opens a browser with `playwright-cli` (raw, `npx @playwright/cli`, `$PWCLI`, a shell wrapper around it, or
`scripts/browser-open.js`) or `agent-browser`,
the result row of that Bash call becomes a player in the Claude Code transcript:

- **Live** while the browser runs.
- **Scrubbable** once it closes, with a seek bar, ⏮ / −10s / ▶ / +10s and **Open in browser**.
- **⤓ Save video** writes `<project>/.replay/live/<start>-<session>.mp4` and `.rrweb.json`.
  ffmpeg renders the MP4 at 15 fps, with idle gaps over 2s shortened. The JSON is a plain
  rrweb event array.
- `/replayio` lists recordings from every session. `/replayio library` opens a page with
  all of them, and `/replayio save <session|latest>` saves one.

Recordings stay under `~/.claude/replayio-live/`, so players in scrollback keep working after a
restart.

## How it works

1. `hooks/register.tsx`, a Claude Code hooks module listed under `modules` in
   `hooks/hooks.json`, starts `live/relay.mjs`: a zero-dependency Node server on 127.0.0.1 with a
   random port and token.
2. On a browser `open` it runs `playwright-cli run-code` with a script that exposes a binding and
   adds `live/tracer.js` as an init script. Every document in the session then streams captured
   packets to the relay through the playwright daemon, so page CSP never blocks it.
3. `tracer.js` is [`@replayio-app-building/session-recorder`](https://www.npmjs.com/package/@replayio-app-building/session-recorder)
   (rrweb plus network, storage and websocket capture), drained every 200 ms.
4. The relay renders `player.html` (rrweb's `Replayer`) in headless Replay Chromium and screencasts PNG
   frames. The hooks module draws them as an `Image` and the seek bar as a `Client`
   (`hooks/scrubber.tsx`).

## Requirements

- A Claude Code build with function hooks, enabled with `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1`.
- A terminal with the kitty graphics protocol (Ghostty, kitty) for the inline picture.
  Elsewhere the row shows the controls and **Open in browser**.
- Replay Chromium (`npx @replayio/replay install`), which the players replay in headlessly with
  recording turned off. `REPLAY_LIVE_CHROME` points them at another Chromium-based browser.
- ffmpeg (`brew install ffmpeg`, `sudo apt-get install ffmpeg`), for **Save video** only.

## Rebuilding the browser assets

`tracer.js` and `vendor/` are committed. To update the recorder or rrweb:

```bash
cd live && npm install && npm run build
```
