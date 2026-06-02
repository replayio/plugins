---
name: "obviously-env"
description: "Use when configuring an Obvious app-building environment for Replay recording through agent-browser. Covers Replay secrets, Replay Chromium, AGENT_BROWSER_EXECUTABLE_PATH, AGENT_BROWSER_STREAM_PORT, and recording flags. This skill is instructions-only and does not use MCP, hooks, scripts, or app bindings."
---

# Obviously Env

Configure the environment before starting `agent-browser` or opening an agent browser session. This plugin is skills-only: do not assume a hook, script, MCP server, or app binding will set anything for you.

## Hard Rules

- Use `agent-browser` as the browser surface for Obvious app testing.
- Do not use `playwright-cli` as the browser driver.
- Do not use a preview pane or embedded webview that cannot honor `AGENT_BROWSER_EXECUTABLE_PATH`.
- Do not use MCP tools from this plugin; it has no MCP server.
- Keep secrets out of logs and final reports.

## Required Environment

Map Obvious secrets into the env vars that Replay and Loop QA tooling expect:

```bash
if [ -z "${REPLAY_API_KEY:-}" ] && [ -n "${SECRET_REPLAY_API_KEY:-}" ]; then
  export REPLAY_API_KEY="$SECRET_REPLAY_API_KEY"
fi

if [ -z "${LOOP_QA_API_KEY:-}" ] && [ -n "${SECRET_LOOP_QA_API_KEY:-}" ]; then
  export LOOP_QA_API_KEY="$SECRET_LOOP_QA_API_KEY"
fi

export RECORD_ALL_CONTENT='1'
export RECORD_REPLAY_VERBOSE='1'
export AGENT_BROWSER_STREAM_PORT="${AGENT_BROWSER_STREAM_PORT:-9223}"
```

Expected secrets:

- `SECRET_REPLAY_API_KEY`: Replay API key used by `replayio` and Replay Chromium.
- `SECRET_LOOP_QA_API_KEY`: Loop QA API token that starts with `lqa_`.

If a host already exposes `REPLAY_API_KEY` or `LOOP_QA_API_KEY`, preserve it.

## Replay Chromium Path

Set `AGENT_BROWSER_EXECUTABLE_PATH` before launching `agent-browser`.

In the Obvious Linux sandbox, Replay Chromium is usually:

```bash
export AGENT_BROWSER_EXECUTABLE_PATH="$HOME/.replay/runtimes/chrome-linux/chrome"
```

On local macOS, Replay Chromium is usually:

```bash
export AGENT_BROWSER_EXECUTABLE_PATH="$HOME/.replay/runtimes/Replay-Chromium.app/Contents/MacOS/Chromium"
```

Verify the selected executable:

```bash
test -x "$AGENT_BROWSER_EXECUTABLE_PATH"
```

If it does not exist, install or refresh Replay Chromium:

```bash
command -v replayio >/dev/null 2>&1 || npm install -g replayio
replayio update-browsers --all
```

Then re-run `test -x "$AGENT_BROWSER_EXECUTABLE_PATH"`.

## Agent Browser Startup Checklist

1. Export `REPLAY_API_KEY` from `SECRET_REPLAY_API_KEY`.
2. Export `LOOP_QA_API_KEY` from `SECRET_LOOP_QA_API_KEY` if Loop QA will be used.
3. Export `AGENT_BROWSER_EXECUTABLE_PATH` to Replay Chromium.
4. Export `AGENT_BROWSER_STREAM_PORT=9223` unless the host provides another port.
5. Export `RECORD_ALL_CONTENT=1` and `RECORD_REPLAY_VERBOSE=1`.
6. Start or reconnect `agent-browser` only after the env is set.
7. Open the app URL in the agent browser and inspect it directly.
8. Close the browser session when done.
9. Upload pending Replay recordings explicitly if you need a URL before responding:

```bash
replayio upload-all || replayio upload --all || replayio upload
```

## Local App Verification

Before browser work, verify the app is reachable from the same environment that will run the browser:

```bash
curl -I http://127.0.0.1:3000
```

Use the actual dev-server URL. Do not assume the requested port stayed available.

## Recording Evidence

When reporting a run, include concrete evidence:

- The app URL tested.
- The browser executable path used, without secrets.
- Whether `test -x "$AGENT_BROWSER_EXECUTABLE_PATH"` passed.
- The Replay recording URL or recording UUID, if available.
- Any blocker, such as missing `SECRET_REPLAY_API_KEY`, missing Replay Chromium, or an auth wall in the app.

## Troubleshooting

- `agent-browser` does not record: confirm it was launched after `AGENT_BROWSER_EXECUTABLE_PATH` was exported.
- `replayio: command not found`: install with `npm install -g replayio`, then retry.
- Replay Chromium missing: run `replayio update-browsers --all`.
- Upload hangs or returns auth errors: verify `REPLAY_API_KEY` is set from `SECRET_REPLAY_API_KEY`.
- Browser stream is unreachable: confirm `AGENT_BROWSER_STREAM_PORT` matches the agent-browser process.
- Loop QA returns 401: verify `LOOP_QA_API_KEY` is set from `SECRET_LOOP_QA_API_KEY` and starts with `lqa_`.
