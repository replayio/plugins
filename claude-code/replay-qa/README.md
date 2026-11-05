# Replay QA for Claude Code

Run [Replay QA](https://qa.replay.io) from Claude Code and watch what it does. Replay QA tests your web app in cloud browsers, reports the bugs it finds with a recording of each, and re-tests your fixes. This plugin lets Claude start those runs, read their results and mark bugs fixed, and it streams the runs live into the conversation.

You need a Replay account. Testing uses your Replay QA plan or credits. The CLI needs Node.js 18 or newer.

## Install

```bash
claude plugin marketplace add replayio/plugins
claude plugin install replay-qa@replayio
```

## Use it

- **Ask Claude.** The `replay-qa` skill covers setting up a project, running QA, reading bugs and verifying fixes.
- **Slash commands:** `/replay-qa:run-full-qa`, `/replay-qa:qa-status`, `/replay-qa:qa-bugs`, `/replay-qa:rerun-journeys`, `/replay-qa:start-new-exploration` and `/replay-qa:report-missing-bug`.
- **Live views:** `/replayqa` follows the folder you're in. It opens the project's dashboard, lists the projects in a monorepo, or suggests how to set up the apps it finds. Tool results also become inline players. These need a Claude Code build with function hooks, enabled with `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1`. See [`live/README.md`](live/README.md).

## Sign in

Open `/replayqa`. If the project needs authentication, its pane shows **Connect Replay QA** and **Sign in with browser** instead of a dashboard login popup.

**Connect Replay QA** opens `/mcp`: choose the plugin's `replay-qa` server and authenticate it. Closing that menu retries the project using the MCP sign-in. A separate server named `replay` is for recording/debugging and does not sign this dashboard in.

If MCP sign-in is unavailable, **Sign in with browser** (or `/replayqa login`) runs the pinned CLI's browser login in your normal browser, then refreshes the project automatically. Cancelled or failed sign-in leaves the recovery actions available. You can also run `npx --yes replayqa@0.7.0 login` in a terminal and choose **Retry**.

Without a browser, set `REPLAY_QA_API_KEY` to a Replay QA API token. A project-access denial is reported separately from a missing sign-in.

## What this plugin runs, sends and stores

- **The `replayqa` CLI.** The skill, the commands and the relay run `npx --yes replayqa@0.7.0`, which npm downloads on first use. It talks to the Replay QA server.
- **Your app, when you test a local one.** `replayqa run` and `replayqa proxy` start your dev command and open an outbound tunnel, so Replay QA's browsers can reach your app. They run only when you or Claude start them, and the live view's **Start** button asks first.
- **The Replay QA MCP server.** The plugin connects to `https://qa.replay.io/api/mcp` and signs in with OAuth.
- **A local relay.** The hooks module starts `live/relay.mjs`, a Node server on `127.0.0.1` with a random port and token. It reads your project's status and recordings from the Replay QA API, and renders inline recordings. The project pane loads the dashboard’s own `/p/` pages, with clicks, keyboard input, scrolling and viewport resizing forwarded to Chromium.
- **The server it talks to.** That is `https://qa.replay.io` unless you choose another one, such as a PR preview, with `REPLAY_QA_URL`, `REPLAY_QA_API_BASE`, `--qa-url`, a dashboard URL, or `proxy.qa-url` in `.replay/config.json`.
- **Credentials it reads.** `REPLAY_QA_API_KEY`, `REPLAY_API_KEY`, `REPLAY_ACCESS_TOKEN` and `~/.replay/profile/auth.json`. They authenticate calls to the Replay QA server, and the plugin hands none of them to the commands Claude runs through Bash.
- **Files it reads.** `.replay/config.json`, and the package files `replayqa detect` uses to find apps in your folder.
- **Files it writes.** Recordings and the servers it has seen go in `~/.claude/replay-qa-live`, or in `REPLAY_QA_LIVE_DIR`. `replayqa link` writes `.replay/config.json`.
- **Playback.** Recordings play with the bundled [rrweb](https://github.com/rrweb-io/rrweb) in a local page, rendered by Replay Chromium or another Chromium-based browser already on your machine. A recorded page can load images and other assets from the sites it was recorded on.

## Privacy, support and license

Replay's [privacy policy](https://replay.io/privacy-policy) and [terms of service](https://replay.io/terms-of-service) apply. For help, use [Replay's contact page](https://replay.io/contact). The plugin is MIT licensed.
