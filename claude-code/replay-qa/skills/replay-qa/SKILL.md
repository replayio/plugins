---
name: "replay-qa"
user-invocable: false
description: "Managed E2E testing service for finding bugs and adversarial verification"
allowed-tools: Bash(npx --yes replayqa@0.7.0 *)
---

# Replay QA

Use Replay QA through the `replayqa` CLI, always as `npx --yes replayqa@0.7.0`: this plugin is written against that version. It preserves project state in the repo and avoids requiring the model to remember raw endpoint details.

## Current Replay QA Context

This block is injected when the skill loads. If shell execution is disabled or auth is missing, use the message to decide which setup step to run next.

```!
npx --yes replayqa@0.7.0 context
```

## Authentication

When the project pane requests sign-in, use **Connect Replay QA** to authenticate the plugin's
`replay-qa` MCP server through `/mcp`. A separate server named `replay` does not authenticate Replay QA.
The pane retries after the MCP menu closes. If that connection is unavailable, use **Sign in with
browser** or `/replayqa login`: the normal browser opens and the project reloads when sign-in succeeds.
Do not use a login popup inside the headless project view or ask the user to paste credentials.


The CLI shares Replay's login cache. Authenticate once:

```bash
npx --yes replayqa@0.7.0 login
```

Without a browser, set `REPLAY_QA_API_KEY` to a Replay QA API token; see https://docs.replay.io/reference/api-keys. app.replay.io API keys are not accepted. Check the active source with `npx --yes replayqa@0.7.0 auth`.

This plugin also declares the Replay QA MCP server (`replay-qa`), whose tools work once the user signs in to it with `/mcp`. Where that server offers `create_cli_credential`, the live views and the tunnels `/replayqa` starts run on that sign-in too, with no `replayqa login`. Production does not offer it yet: until it does they need `replayqa login`, even for someone signed in through `/mcp`. The `replayqa` commands you run through Bash use the sources above, or a sign-in they saved from that server. If they report no sign-in and the server has the tool, sign the CLI in once: run `npx --yes replayqa@0.7.0 login --mcp-challenge`, call `create_cli_credential` with the `code_challenge` it prints, then within a minute run `REPLAY_QA_URL="<qa_url>" npx --yes replayqa@0.7.0 login --mcp-credential "<credential>"`. The credential is useless without the secret the CLI kept. Otherwise ask the user to run `replayqa login`, or use the MCP server's tools.

## Project Reuse

Project ids are resolved in this order: `--project <id or URL>`, then `REPLAY_QA_PROJECT_ID`, then `qa-project-id` in the nearest `.replay/config.json` from the current folder up to the git root. Reuse the stored project for all Replay QA work in that folder. Do not create a duplicate unless the user explicitly asks for a new project or the stored one is proven invalid for the current account.

Run `npx --yes replayqa@0.7.0 detect --json` first to see what a folder holds. If it reports `projects`, use those and don't look for apps; with several (a monorepo), ask which one, and run from its folder or pass it with `--project`. With none, its `apps` are suggestions to confirm with the user: ports are guesses, and apps collide on them. Each has a `setup.command` that starts the app and its tunnel. It reads files only and runs nothing from the folder.

If the user gives a dashboard URL, pass it with `--project`; `npx --yes replayqa@0.7.0 link <id or URL>` links the folder to a project that already exists. If there is no project, `bootstrap` and `full-qa` create one and write its id to `.replay/config.json`, preserving other keys. Without a config, a package in a monorepo keeps its own, so each app can be its own project.

When reporting setup, say whether the id was reused from `.replay/config.json`, passed explicitly, read from the environment, or created and written back.

## Local Apps

Replay QA needs network access to the app under test. Do not create, scaffold, or modify the target application unless the user asks, and do not add a `.replay/config.json` merely because this skill loaded.

From the app's repository, start its normal dev server behind the CLI's wrapper. The target URL is the stable browser-visible origin and the upstream URL is the dev server; their ports must differ:

```bash
npx --yes replayqa@0.7.0 run http://localhost:3000 \
  --upstream-url http://127.0.0.1:5173 \
  --app-command "npm run dev -- --host 0.0.0.0 --port 5173" \
  --project proj_123
```

`run` keeps the app, wrapper and proxy alive until interrupted, so run it in a background shell. It does not create a project: use a configured id, pass one, or add `--create-project` when the user asks for a new one. For an app that is already running, use `--no-app`, or connect it directly:

```bash
npx --yes replayqa@0.7.0 proxy --project proj_123 --target-url http://localhost:3000
```

Use `--allow` when the browser must reach additional local or private hosts. Pass `--public` to project creation when the user provides a public URL.

## Commands

Every command prints JSON for agent use. `npx --yes replayqa@0.7.0 <command> --help` gives its options, and `npx --yes replayqa@0.7.0 skill` prints the CLI's full guide.

| Command | Purpose |
| --- | --- |
| `detect [folder]` | What a folder holds: the projects its configs name, or else the packages that look like apps, each with the command that sets it up. |
| `link <id or URL>` | Link this folder to a project that already exists, writing `qa-project-id`. |
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

## User Entry Point

`/replayqa` is the plugin's single visible slash command. This skill remains available for Claude
to invoke automatically when the user asks to run QA, inspect bugs, check status, or verify fixes.
Use the CLI workflows below to carry out those requests; do not suggest namespaced slash commands.

With function hooks enabled the plugin adds `/replayqa` (no namespace). With no argument it follows the session's folder: one project opens its dashboard, several draw an index to choose from, and none draw the list to set one up, with one action per app to start it and its tunnel. `/replayqa canvas [project]`, `/replayqa setup` (the list, even where a project is configured), `/replayqa use <project>`, `/replayqa test <url>`, `/replayqa start|stop <app path>`, `/replayqa live`, `/replayqa open [recording]`, `/replayqa follow|unfollow [project]`, `/replayqa status`.

## Live Views

When the Claude Code session has function hooks enabled (`CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1`), this plugin streams Replay QA work into the conversation. You do not run anything extra:

- Starting an exploration (`start-exploration`), marking a bug fixed (`mark-bug … fixed`, which makes Replay QA re-test the journey), or reporting a missed bug (`report-missing-bug`) turns that call's result into a live rrweb player. The project is followed, so every exploration and journey run that is executing streams in parallel, and finished runs can be opened from the dashboard.
- `/replayqa` opens the dashboard's `/p/<project>/overview` page. Click, type and scroll to use it; resizing the pane resizes the browser without navigating away. `/replayqa canvas` is a compatible alias. It never opens a project seen in another folder. `/replayqa live` lists what is streaming, and `/replayqa open` opens a player in the browser.
- The streams are read with `replayqa recording-events` through a local relay; nothing is sent anywhere else.

When you start an exploration for the user, say that the live player is in the result and mention `/replayqa canvas`. Do not poll the stream yourself: keep using `status` and `bugs` for state, and read the bug reports for findings.

## Agent Workflow

Use this loop for QA and repair:

1. Start or confirm the app under test.
2. Run `full-qa` with the target URL and any user instructions.
3. If a private target needs connecting, keep `replayqa run` or `replayqa proxy` running in a background shell.
4. Poll `status` until there is useful progress.
5. Fetch open bug details with `bugs --status open --details --save`. They land under `.replay/qa-bugs/`.
6. Read the full bug report before editing code. Use Replay QA's reproduction steps, expected behavior, actual behavior, evidence, and root-cause analysis as the primary debugging source.
7. Fix the codebase.
8. Mark each fixed bug with `mark-bug <bug-id> fixed`; Replay QA automatically retries the affected journey.
9. Poll status and list open bugs again.
10. Repeat until no open bugs remain.

Do not manually start new explorations unless the user asks. Project creation already starts the normal QA workflow.

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
