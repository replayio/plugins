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

## The session's folder

`/replayqa` follows the folder the session is in. It runs `replayqa detect --json` there and shows:

- **One project:** its canvas.
- **Several** (a monorepo, each app with its own `.replay/config.json`): an index, in the pane and in the
  browser view (`folder.html`). Choosing one opens its canvas, and **Projects** comes back.
- **None:** a setup list of the apps it found, with why each was picked and the exact command, and one action
  per app to start it. These are suggestions: nothing has been run, and ports are guesses, so Start asks first and
  says when something already listens on the port. It also offers using an existing project (`replayqa link`) and
  testing a public URL (`replayqa bootstrap --public`).

If `replayqa detect` can't run (offline, or the pinned CLI not published yet) the nearest `.replay/config.json` stands
in for it, and the pane says why. A project is never taken from another folder: besides the config, the only fallback
is the last project seen in this same folder (its nearest config's, else its git root).

The index and the list are drawn as native rows, not as the canvas screencast. In a docked pane a 1600px page scaled to
fit is too small to read, a command in a picture can't be selected, a field in one can't be typed in, and this is what
a person sees first, before Replay Chromium or a terminal with graphics are known to be there. For the same reason an
error from the QA server is a row of its own above the picture. It names the server it asked, and says when that server
is a PR's preview, which goes away with its PR.

Start runs `replayqa run` under the relay rather than the hooks module: it has to stay up for the whole test, the relay
outlives any press, and the relay already exits when Claude Code goes away. `replayqa` keeps the app in a process group of
its own and stops it itself only once the tunnel is up, so stopping a run signals the whole process tree.

## Signing in

The plugin declares the Replay QA MCP server (`../.mcp.json`). Where that server offers `create_cli_credential`, sign in once with
`/mcp`, and:

- The hooks module asks the relay for a code challenge, then asks the server's `create_cli_credential` tool for a single-use `mcl_`
  credential bound to it once, through the engine's own connection and with no model involved, when a `/replayqa` command or a Replay QA tool call needs the relay signed in. The
  engine puts that call to the session's permission mode, and a `tool.check` hook allows the plugin's own. That hook only runs
  for a call made from a hook: from a button, a timer or a loop the engine skips it, and the person gets a dialog about a tool they
  never asked for. So nothing else here calls it through the engine, and the model calling the tool itself still asks. Plan mode
  does not let a hook loosen anything, so there a `/replayqa` on a server with the tool does show that dialog; it holds nothing up.
- **The relay** keeps the verifier for that challenge and exchanges the credential at `/api/oauth-token` (`mcp-auth.mjs`), holds
  the tokens in memory and refreshes them.
  It uses them for its own API calls, and passes the current access token to the `recording-events` readers it runs; a
  reader that outlives a token is started again and skips the rows it already applied. A token only goes to the server
  that issued it.
- **`replayqa run` and `bootstrap`** each get a credential of their own as `REPLAY_QA_API_KEY`, which the relay mints on its sign-in by
  calling the same tool at `<server>/api/mcp` and adding the verifier it kept. The CLI takes it out of its environment at startup, so the app doesn't inherit
  it, redeems it at once, because it lasts a minute, and refreshes in memory, so a tunnel outlives the hour-long token.

When the server isn't connected, needs a sign-in or has no such tool, all of this falls back to `REPLAY_QA_API_KEY`, then
`~/.replay/profile/auth.json` (`replayqa login`), with nothing said unless there is no sign-in at all.

Production has no such tool yet, so there this fallback is the normal path, even for someone signed in through `/mcp`. Its other
tools work on that sign-in as usual. A server can list its tools to anyone and answer 401 only to a call, so being connected says
nothing about being signed in, and with no such tool the two fail alike. So the pane offers `/mcp` only when the server has
actually asked for a sign-in, and otherwise says `replayqa login`, which always works.

The plugin hands no credential to `replayqa` commands the model runs through Bash. A `tool.call` rewrite stays out of the transcript
file, but permission rules (`Bash(npx --yes replayqa@… *)` stops matching), permission prompts, an SDK's `permission_denials` and the
person's own `PreToolUse` hooks all see the command as rewritten. The model can sign the CLI in itself, as the skill says, with
`replayqa login --mcp-challenge` and `--mcp-credential`. What that puts in the transcript is useless without the secret the CLI kept.

Credentials and tokens never go in a URL, a log line, a toast or the transcript. Routes only the hooks module may use take a
header no page has (`hookToken`): a page's URL holds the relay's token, and a browser keeps its history.

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

`recording-events` owns what the API makes necessary: pages over its 6 MB limit are fetched smaller, and events too big for one row are joined back together. The CLI is pinned, in `relay.mjs` as in the skill and `hooks/register.tsx`, so a release cannot change this stream by itself. The relay still calls the API itself for the project overview it polls, as starting a process for each poll would be too slow.

A project on another QA server (a PR preview, staging) is read from that server. The relay takes it
from a running tunnel (`replayqa proxy|run --project <id> --qa-url <url>`, the command the server's own
reverse-proxy runbook prints), or from what the hooks module saw: a dashboard URL given to
`/replayqa canvas <url>`, `REPLAY_QA_API_BASE` or `REPLAY_QA_URL` on a command, `--qa-url` in a
command's output, or `proxy.qa-url` in `.replay/config.json`. It remembers each in `servers.json`; anything
else uses `REPLAY_QA_API_BASE`, `REPLAY_QA_URL` or qa.replay.io. See Signing in for what it authenticates with.

## Requirements

- A Claude Code build with function hooks, enabled with `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1`.
- A terminal with the kitty graphics protocol (Ghostty, kitty) for the inline picture. Elsewhere the
  row shows its controls and **Open in browser**.
- Replay Chromium (`npx @replayio/replay install`) for the headless renderer (`REPLAY_LIVE_CHROME`
  points at another Chromium-based browser).

## Development

```bash
npm test         # the relay, against a mock of the QA API; REPLAY_QA_CLI="node /path/to/replayqa-cli/bin.js" uses a checkout of the CLI
npm run demo     # the mock API and the relay; prints folder and canvas URLs to open in a browser (DEMO_VIEW=index|setup|none|nodetect)
```

`test/mock-qa-api.mjs` serves the same response shapes as the real API, with its size cap and chunking,
and runs that reveal their events over time, so nothing here spends QA credits.
