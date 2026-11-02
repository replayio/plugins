# rrweb recordings

Every agent-browser session a Replay plugin sees runs in Replay Chromium and is recorded as an rrweb stream. This folder is that recorder, shared by every host: `sync-hosts.mjs` copies it to the Codex, Cursor and OpenCode plugins.

- `~/.replay/rrweb/recordings/<time>-<session>-<id>.rrweb` holds each recording, appended as it happens. One JSON value per line: a line whose `type` is a number is an rrweb event, verbatim; one whose `type` is a string is the recorder's own (`header`, `feed`, `replay`, `end`). A plain JSON array of rrweb events plays too.
- `rrweb.mjs play [latest|session|id|path]` opens a viewer that streams a recording live while it is being made and plays it with a seek bar afterwards.
- In Claude Code the row that started the browser becomes that player, and the `play_recording` tool puts any existing recording on its own row. `/replayio` lists them.

## How it works

1. A host notices an `agent-browser` command: the Claude Code mod through `tool.call`, the others through a shell hook running `rrweb.mjs hook`. agent-browser starts a browser for any command that needs one, so every such verb counts (`hooks/detect.ts`).
2. `rrweb.mjs` starts `relay.mjs` if it is not running: one zero-dependency Node daemon per machine, on 127.0.0.1 with a random port and token, described by `~/.replay/rrweb/relay.json`. It exits after an idle hour.
3. The relay joins the browser over CDP (`agent-browser get cdp-url`) and adds `tracer.js` as a new-document script with a binding for its packets, so page CSP never blocks it. A session keeps one recording until its browser goes away, however that happens.
4. `tracer.js` is [`@replayio-app-building/session-recorder`](https://www.npmjs.com/package/@replayio-app-building/session-recorder) (rrweb plus network, storage and websocket capture), drained every 200 ms.
5. `player.html` plays a recording with rrweb's `Replayer`, over SSE when live. For Claude Code the relay renders it in headless Replay Chromium, with recording off, and screencasts PNG frames the hooks module draws as an `Image`, with the seek bar as a `Client` (`hooks/scrubber.tsx`).

Injecting into a page Replay Chromium is recording means the Replay recording also holds the recorder's own execution.

## Requirements

- Node 22 or later, and `agent-browser` on the `PATH`.
- Replay Chromium (`npx @replayio/replay install`). `REPLAY_LIVE_CHROME` points the headless renderer at another Chromium-based browser.
- For the inline picture: Claude Code with function hooks (`CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1`) and a terminal with the kitty graphics protocol (Ghostty, kitty). Elsewhere the row has the controls and **Open in browser**.

`REPLAY_RRWEB_DIR` moves everything from `~/.replay/rrweb`.

## Rebuilding

`tracer.js`, `detect.mjs`, `vendor/` and the other hosts' copies are committed. After changing any of them, or `hooks/detect.ts`:

```bash
cd live && npm install && npm run build
```
