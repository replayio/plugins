---
name: "replay-qa"
description: "Use when running Replay QA against production, staging, PR preview, or other reachable app URLs from Codex. Uses the replayqa CLI for project creation/reuse, status, bugs, journeys, test runs, explorations, and bug-fix verification."
---

# Replay QA

Use Replay QA through the `replayqa` CLI, always as `npx --yes replayqa@0.7.0`: this plugin is written against that version. It preserves project state in the repo and avoids requiring the model to remember raw endpoint details.

If `npx` is not found, Node is usually installed through a version manager the shell has not loaded. Look in `~/.nvm/versions/node/*/bin`, `~/.volta/bin`, `~/.local/share/fnm`, `~/.asdf/shims`, `/opt/homebrew/bin` and `/usr/local/bin`, and put that directory on `PATH` for the command. Do not download Node: if none is there, tell the user.

This Codex package is for QA runs against production, staging, PR previews, and other reachable app URLs. Direct Replay.io recording and MCP debugging belong to the `replayio` / `codex-pro` package.

## Authentication

When the Replay QA MCP server is connected, use its sign-in, so the user needs no second login. Prefer its tools (`list_projects`, `list_bugs`, `get_bug`, `set_bug_status` and so on) for reads and changes. `detect` and `link` need no sign-in. Before the first CLI command that does, such as `run` or `proxy`, sign the CLI in through the server, once per machine:

```bash
npx --yes replayqa@0.7.0 login --mcp-challenge
```

Call `create_cli_credential` with the `code_challenge` it prints, then within a minute:

```bash
REPLAY_QA_URL="<qa_url>" npx --yes replayqa@0.7.0 login --mcp-credential "<credential>"
```

Later commands are signed in. If `qa_url` is not `https://qa.replay.io`, keep `REPLAY_QA_URL` set on them. The credential is useless without the secret the CLI kept, and it works once. If it expires, start again from `--mcp-challenge`.

Being connected does not mean signed in, and not every server has `create_cli_credential` yet. If the server is not connected, a tool call says it is not signed in, or `create_cli_credential` is missing or fails, use the CLI with its own login instead. The CLI shares Replay's login cache. Authenticate once:

```bash
npx --yes replayqa@0.7.0 login
```

If `SECRET_REPLAY_QA_API_KEY` is available and `REPLAY_QA_API_KEY` is not set, map it before running commands:

```bash
if [ -z "${REPLAY_QA_API_KEY:-}" ] && [ -n "${SECRET_REPLAY_QA_API_KEY:-}" ]; then
  export REPLAY_QA_API_KEY="$SECRET_REPLAY_QA_API_KEY"
fi
```

Without a browser, set `REPLAY_QA_API_KEY` to a Replay QA API token; see https://docs.replay.io/reference/api-keys. app.replay.io API keys are not accepted. Check the active source with `npx --yes replayqa@0.7.0 auth`.

## Which Project

Before creating or selecting a project for the user's code, run this in their folder:

```bash
npx --yes replayqa@0.7.0 detect --json
```

It reads files only and runs nothing from the folder.

- **`projects`** lists the `.replay/config.json` files at or under the folder. Rely on them and do not look for apps. One is the project. Several, as in a monorepo, are each linked: ask which one unless the request says.
- **With no `projects`**, `apps` lists the packages that look like apps. It recognizes Nx, Turborepo, and pnpm, npm, yarn and bun workspaces. These are suggestions to confirm with the user: ports are guesses, and `port_shared_with` says when they collide. See Local Apps.

A project the user names, or the one in the latest Replay QA app context, comes first: pass it with `--project` so a config cannot select a different one. If the app context says no project is selected, ask which one instead of reusing an earlier selection or falling back to the config.

Other commands resolve the project in this order: `--project <id or URL>`, then `REPLAY_QA_PROJECT_ID`, then `qa-project-id` in the nearest `.replay/config.json` between the current directory and the git root. Do not create a duplicate project unless the user explicitly asks for one or the stored project is proven invalid for the current account.

If there is no project, `bootstrap`, `full-qa` and `run --create-project` create one and write its id to `.replay/config.json`, preserving other keys. A package in a monorepo keeps its own config, so each app can be its own project. To connect a project that already exists, run `link <project id or URL>` from the app's folder.

When reporting setup, say whether the id was reused from `.replay/config.json`, passed explicitly, read from the environment, or created and written back.

## Target URLs

Use public or externally reachable URLs for the normal Replay QA workflow:

```bash
npx --yes replayqa@0.7.0 full-qa https://pr-123--example.netlify.app "Run smoke QA across auth, onboarding, checkout, navigation, and persistence."
npx --yes replayqa@0.7.0 full-qa https://staging.example.com "Test the release candidate."
npx --yes replayqa@0.7.0 full-qa https://app.example.com "Regression test the production critical paths."
```

## Local Apps

Replay QA needs network access to the app under test. Do not create, scaffold, or modify the target application unless the user asks, and do not add a `.replay/config.json` merely because this skill loaded.

`detect` gives each app a `setup.command` that starts it and its tunnel from the app's folder. Use the app's documented command or the user's approved setup; ask only when the command or intended app is ambiguous.

Before starting a dev server, wrapper, or tunnel, check **every listener**: the upstream app, the wrapper target, the local forward proxy, and any emulators. In the pinned CLI 0.7.0, the forward proxy defaults to **127.0.0.1:8888**; another Replay QA session may already own it. Choose an explicit free `--local-port` for each tunnel. Use `lsof -nP -iTCP:<port> -sTCP:LISTEN`, identify existing listeners, and verify which app they serve. Reuse the intended app with `--no-app` or `proxy`. Reuse a tunnel only after verifying its project and target. Choose another port for an unrelated listener; do not kill it to free the port.

From the app's folder, keep the browser-visible wrapper URL and upstream dev server URL distinct. After confirming ports 3000, 5173, and 8890 are available, an existing project's setup is:

```bash
npx --yes replayqa@0.7.0 run http://localhost:3000 \
  --upstream-url http://127.0.0.1:5173 \
  --app-command "npm run dev -- --host 0.0.0.0 --port 5173" \
  --project proj_123 --local-port 8890 --json
```

For an authorized **new local project**, replace `--project proj_123` with `--create-project --no-start-exploration`. When creating it through MCP instead, pass `start_exploration: false`. Do not call `full-qa` or `bootstrap` with their default automatic exploration against a disconnected local app.

Keep `run` alive in a background shell: it owns the app, wrapper, and tunnel. With `--no-app`, it still owns any wrapper it creates and the tunnel. A startup message, reachable upstream, or allocated tunnel address does not establish readiness. Wait for a `heartbeat` event with `"ready": true`, then inspect the project's `context` and `reverse-proxy` status. Check the resolved target URL and Local environment against the browser-visible URL you intended to test.

Only after readiness, start the one initial exploration requested by a new local QA task, using the project ID that was created and saved:

```bash
npx --yes replayqa@0.7.0 start-exploration \
  --project proj_123 --prompt "Test the app's main flows, validation, and persistence."
```

For a reused project, connecting the tunnel can resume queued journeys; do not create another exploration unless the user requested one. Keep the process alive until the requested QA finishes, and keep checking connection health while monitoring its runs.

For an app already serving at the intended browser-visible URL, connect directly with a verified free proxy port:

```bash
npx --yes replayqa@0.7.0 proxy --project proj_123 \
  --target-url http://localhost:3000 --local-port 8890 --json
```

When recovering a setup with a wrapper, preserve its browser-visible URL. If `run` exited, restart it with the same target and upstream, using `--no-app` when the upstream is still running. Switching `proxy --target-url` to the upstream can leave the Local environment and the project's default URL different. If an exploration still uses the old URL, inspect its resolved target and environment before retrying; do not silently change the shared project default or launch repeated explorations against that stale URL.

Describe tunnel startup as pending until readiness is confirmed; do not promise a fixed startup time. Keep the process running while provisioning or DNS advances. If there is no progress for two minutes, inspect its logs and run `doctor` from another shell before retrying. Process exit, port conflicts, and authentication errors need immediate diagnosis. If a ready tunnel later returns 502, `ECONNREFUSED`, or DNS errors, inspect the connection and resolved target before resuming QA; report tunnel failures as infrastructure obstacles rather than app defects.

Use `--allow` when the browser must reach additional local or private hosts. Pass `--public` to project creation when the user provides a public URL.

## Commands

Every command prints JSON for agent use. `npx --yes replayqa@0.7.0 <command> --help` gives its options, and `npx --yes replayqa@0.7.0 skill` prints the CLI's full guide.

| Command | Purpose |
| --- | --- |
| `full-qa [url] [instructions]` | Create or reuse a project, show status and reverse-proxy setup, fetch open bug details, and print next steps. |
| `bootstrap [url] [instructions]` | Create or reuse a project, then show details, status, and reverse-proxy setup. |
| `context` | Concise current project context, status, and open bug summaries. |
| `status` | Show project status; pass `--watch` to poll. |
| `reverse-proxy` | Show reverse-proxy setup; pass `--wait` to poll until instructions are ready. |
| `explorations` | List explorations. |
| `start-exploration <prompt>` | Start a focused exploration only when the user asks for one. |
| `journeys` | List journeys, or filter with `--journey-id`. |
| `test-runs` | List test runs; pass `--journey-id` to review a single journey's run history. |
| `bugs` | List bugs; use `--status`, `--details`, and `--save`. `--raw` prints the unmodified API response. |
| `bug <id>` | Fetch one bug. |
| `mark-bug <id> [status]` | Mark a bug `fixed`, `wontfix`, `invalid`, or `reopened`. Marking `fixed` automatically retries the affected journey. |
| `report-missing-bug <description>` | Report a missing bug and ask Replay QA to create an investigation journey. |
| `rerun-journeys` | Supported journey retry alternatives, as there is no direct single-journey rerun endpoint. |
| `recording-events <run-…\|expl-…\|task-…>` | Stream a run's rrweb events and notes, one JSON value per line; `--follow` until it finishes. For viewers: full snapshots are large, so do not read it yourself. |
| `detect [folder]` | What a folder holds for Replay QA: its linked projects, or else the packages that look like apps, with their setup commands. Reads files only. |
| `link <project id or URL>` | Link this folder to a project that already exists. |
| `doctor` | Diagnose authentication, managed dependencies, DNS, and recent proxy failures. `--fix` repairs managed dependencies. |

Bug-type exclusions in the instructions (for example "Exclude accessibility.") switch those bug types off project-wide. Relay the printed "Bug types" notice to the user. To review them before QA starts, pass `--no-start-exploration` when creating the project, then run `start-exploration`.

Common examples:

```bash
npx --yes replayqa@0.7.0 status --watch
npx --yes replayqa@0.7.0 bugs --project "https://qa.replay.io/projects/proj-example/bugs"
npx --yes replayqa@0.7.0 bugs --status open --details --save
npx --yes replayqa@0.7.0 bug bug_id_here --save
npx --yes replayqa@0.7.0 mark-bug bug_id_here fixed
npx --yes replayqa@0.7.0 start-exploration "Focus on onboarding, invalid inputs, refreshes, and back navigation."
npx --yes replayqa@0.7.0 rerun-journeys --bug-id bug_id_here
npx --yes replayqa@0.7.0 report-missing-bug "Settings changes do not persist after refresh."
```

## Replay QA View

The plugin connects the Replay QA MCP server, which signs in with Replay on first use. When the user wants to see Replay QA results, call its `open_qa_dashboard` tool instead of printing lists:

- For "open Replay QA" or anything about their code, pass the `detect --json` output as `workspace`. One project opens it. Several list those projects with their folders. None lists the apps found, with a setup action for each.
- For "show my projects", call it with no arguments.
- When the user names a project, pass `project_id` (an id or a dashboard URL). `page` opens `overview`, `bugs` or `test-runs`.
- Pass `bug_id`, `test_session_id`, `journey_id` or `test_run_id` to open that page directly.

`open_qa_dashboard` opens a new view each time, so use it only when none is open. When the latest Replay QA app context has a `view_id`, the user already has a view, as when they are chatting beside the Replay QA canvas: call `show_in_qa_dashboard` with that `view_id` and the same arguments, and the open view changes page. If it answers that the view is no longer open, or the server has no such tool, call `open_qa_dashboard`.

If the server has no `open_qa_dashboard` tool yet, say the view is not available and print the lists.

Where the host draws MCP Apps, the view is the site's own pages, and the latest app context names the exact page the user is on: its project, and any bug, test run or journey. Use it for "this bug", "this run" and "this project". It follows the page, so going back drops the bug. A page being open never authorizes starting QA. Its setup actions send you a message with the exact command to run. Elsewhere the tool answers with a one-line summary, and the commands above remain the way to read details.

## Agent Workflow

Use this loop for QA and repair:

1. Start or confirm the app under test.
2. For a public target, run `full-qa` with the URL and user instructions. For a local target, follow Local Apps: defer new-project exploration until the tunnel is ready.
3. Keep any local `replayqa run` or `replayqa proxy` process alive while the requested QA runs.
4. Poll `status` until there is useful progress.
5. Fetch open bug details with `bugs --status open --details --save`. They land under `.replay/qa-bugs/`.
6. Read the full bug report before editing code. Use Replay QA's reproduction steps, expected behavior, actual behavior, evidence, and root-cause analysis as the primary debugging source.
7. Fix the codebase.
8. Mark each fixed bug with `mark-bug <bug-id> fixed`; Replay QA automatically retries the affected journey.
9. Poll status and list open bugs again.
10. Repeat until no open bugs remain.

Start the deferred initial local exploration once the requested setup is ready. Otherwise, do not start new explorations unless the user asks; ordinary project creation already starts its initial exploration.

## Journey Reruns

The current OpenAPI spec exposes journeys and test runs, but it does not expose a direct endpoint to manually run one journey. Use these supported alternatives:

1. To inspect prior runs for a journey, run `test-runs --journey-id <journey-id>`.
2. To verify a bug fix, run `mark-bug <bug-id> fixed`; Replay QA automatically retries the affected journey.
3. To investigate a missed scenario, run `report-missing-bug "<description>"`; Replay QA creates an investigation journey.

Do not claim that a journey was manually rerun unless one of the supported flows actually triggered verification.

## Troubleshooting

- Run `doctor` first: it checks authentication, the managed `frpc`, storage, tunnel DNS, and recent proxy failures without starting anything. Use `--fix` only when its report identifies a broken managed dependency.
- Run `auth` if the API rejects a request.
- Run `status --watch` to distinguish queued work from a disconnected proxy.
