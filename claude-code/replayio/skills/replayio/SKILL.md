---
name: "replayio-pro"
description: "Use when you need Replay.io Pro in Claude Code: record or inspect a Replay browser run, watch or replay its rrweb stream, test a local app with Replay Chromium, or use Replay MCP for deeper debugging."
allowed-tools: Bash(node *), Bash(npx *), Bash(agent-browser *), Bash(replayio *), Bash(file *), Bash(test *), Bash(command *)
---

# Replay.io Pro For Claude Code

Use this skill for direct Replay.io dev tools. Replay QA project, bug, journey, and exploration workflows belong to the separate `replay-qa` / `claude-code` package.

## Paths

Resolve the plugin root from this loaded skill:

```bash
SKILL_DIR="${CLAUDE_SKILL_DIR:-.claude/skills/replayio/skills/replayio}"
PLUGIN_ROOT="$(cd "$SKILL_DIR/../.." && pwd)"
SCRIPT_DIR="$PLUGIN_ROOT/scripts"
AGENT_DIR="$PLUGIN_ROOT/agents"
```

Available scripts:

| Script | Purpose |
| --- | --- |
| `browser-open.js` | Open a URL in Replay Chromium with agent-browser and record it. Prints `agent_browser_session`, `rrweb_file` and `viewer_url`. |
| `browser-close.js` | Close that browser, finish its `.rrweb` file, and upload its Replay recordings. |

Available subagents:

| Subagent | Purpose |
| --- | --- |
| `replay-worker` | Implementation worker that builds, self-validates in the browser, and records the final proof session. |
| `replay-critic` | Read-only adversarial critic that inspects the Replay recording against requirements and diff evidence. |

Run the setup check first when setup is unknown:

```bash
node "$SKILL_DIR/scripts/context.js"
```

For host agent-browser runs, launch Replay Chromium with a read-only snapshot of the main Chrome profile so existing cookies and login state are available:

```bash
export AGENT_BROWSER_EXECUTABLE_PATH="$HOME/.replay/runtimes/Replay-Chromium.app/Contents/MacOS/Chromium"
export AGENT_BROWSER_PROFILE="${AGENT_BROWSER_PROFILE:-Default}"
```

Run `agent-browser profiles` to select another Chrome profile by display or directory name. Agent-browser does not modify the source profile and deletes its temporary copy when the Replay browser closes. Omit `AGENT_BROWSER_PROFILE` for a clean unauthenticated run.

## Build-And-Falsify Loop

Use `replay-worker` and `replay-critic` when the user asks for Replay-backed proof, adversarial verification, "agents that prove their work", or a UI/code change whose browser behavior should be validated by runtime evidence.

The worker and critic must be separate roles:

1. Worker: edits code, runs normal checks, drives the app, and records the final walkthrough under Replay Chromium.
2. Critic: receives requirements, the worker claim, uploaded recording IDs/URLs, and the PR diff as static input. It reviews only the evidence through Replay MCP and the supplied diff. It must not edit files, run shell commands, or drive a fresh browser.

Loop on the critic verdict:

- `needs_revision`: send the finding back to the worker, change the implementation, record a new proof session, and re-run the critic.
- `needs_evidence`: keep the implementation, record a better session that exercises the missing path, and re-run the critic.
- `satisfied`: report the proof artifacts and any suite promotion recommendation.

The recording is the unit of evidence. Screenshots, DOM snapshots, local rrweb files, and passing self-checks are supporting context; the critic should treat the uploaded Replay timeline as the source of truth for runtime state, network requests, source execution, exceptions, and mock-data audit.

## Signing In To Replay

Uploads need a signed-in `replayio` CLI. Signed out, the stop hook and `browser-close.js` leave recordings local and say so, rather than block on a sign-in. When that happens, or `replayio whoami` reports `not authenticated`:

1. Start the interactive sign-in in the background: run `replayio login` with `run_in_background` (it opens a browser tab).
2. Stop. End your turn and ask the user to tell you once they have signed in. Do not poll, retry uploads, or continue with work that needs the upload.
3. When the user confirms, check `replayio whoami`, then upload with `replayio upload <ids>` (see `references/cli.md`).

## rrweb Recordings

Every agent-browser session is recorded. In Claude Code the plugin joins the browser over CDP, injects an rrweb recorder into each page, and appends the stream to a `.rrweb` file:

```text
~/.replay/rrweb/recordings/<time>-<session>-<id>.rrweb
```

The file holds one JSON value per line: a line whose `type` is a number is an rrweb event, verbatim, and one whose `type` is a string is the recorder's own (`header`, `feed`, `replay`, `end`). It grows as the browser runs, so it is complete up to the last event even if the browser crashes. `jq -s 'map(select(.type | numbers))' file.rrweb` turns one into a plain rrweb event array.

The row that started a browser becomes a player in the conversation: live while the browser runs, scrubbable once it closes. To replay one that already exists, call the `play_recording` tool with `latest`, a session name, a recording id, or the path of a `.rrweb` file; it draws the same player on its own row. `/replayio` lists them all.

The recording captures what the pages showed, so with a Chrome profile imported it includes logged-in content. Password inputs are masked. Files are readable only by the current user and stay on this machine.

## Driving The Browser

The plugin points every `agent-browser` at Replay Chromium and turns recording on, so use it directly. Name a session when more than one browser is open:

```bash
agent-browser --session "$NAME" open "$URL"
agent-browser --session "$NAME" snapshot
agent-browser --session "$NAME" close
```

`node "$SCRIPT_DIR/browser-open.js" "$URL" --session "$NAME"` and `browser-close.js --session "$NAME"` do the same with JSON output, and `browser-close.js` also reports the Replay URLs. Close the browser before you report results: the recording only finishes then, and the stop hook closes any left open in this directory.

## Purpose-Built `record:replay` Scripts

When a local app needs repeatable full-stack recording, add a project-specific `record:replay` script instead of driving ad hoc sessions. This is the right pattern for local emulators, seeded auth, a database/API service, or multiple browser sessions.

The script should start required services, wait for health, run a dedicated Replay Playwright config, poll `replayio list --json` until new recordings are `finished`, upload only finished IDs, write `recordings/latest.json`, and stop every spawned process in `finally`.

## References

- `references/cli.md` covers the lifecycle scripts, rrweb recordings, multi-session recording, and `jq` filtering.
- `references/workflows.md` covers the standard browser workflow and worker/critic loop.
