---
name: "replay-qa"
description: "Use when running Replay QA against production, staging, PR preview, or other reachable app URLs from Codex. Provides packaged scripts for project creation/reuse, status, bugs, journeys, test runs, explorations, and bug-fix verification."
---

# Replay QA

Use Replay QA through the bundled scripts in the `scripts/` directory next to this `SKILL.md`. The scripts call the Replay QA HTTP API directly, preserve project state in the repo, and avoid requiring the model to remember raw endpoint details.

This Codex package is for QA runs against production, staging, PR previews, and other reachable app URLs. Browser video evidence and Replay.io MCP debugging belong to the `replayio` / `codex-pro` package.

## Script Path

Resolve the script directory from the absolute path of this loaded skill:

```bash
SKILL_DIR="/absolute/path/to/skills/replay-qa"
SCRIPT_DIR="$SKILL_DIR/scripts"
```

When Codex lists this skill, use that listed filesystem path for `SKILL_DIR`. Do not guess a project-local path unless this package was installed into the current project.

## Authentication

The scripts look for a token in this order:

1. `REPLAY_QA_API_KEY`
2. `REPLAY_API_KEY`
3. `REPLAY_ACCESS_TOKEN`
4. `~/.replay/profile/auth.json`

If `SECRET_REPLAY_QA_API_KEY` is available and `REPLAY_QA_API_KEY` is not set, map it before running scripts:

```bash
if [ -z "${REPLAY_QA_API_KEY:-}" ] && [ -n "${SECRET_REPLAY_QA_API_KEY:-}" ]; then
  export REPLAY_QA_API_KEY="$SECRET_REPLAY_QA_API_KEY"
fi
```

If the user is not logged in, run:

```bash
npx replayio login
npx replayio whoami
```

Never print API tokens. If the API returns 401, ask the user to export a Replay QA API token as `REPLAY_QA_API_KEY` or `REPLAY_API_KEY`.

## Project Reuse

Before creating or selecting a Replay QA project, inspect the current project root for `.replay/config.json`.

Resolve the project root with `git rev-parse --show-toplevel`; if that fails, use the current directory. If `.replay/config.json` contains a non-empty string property named `"qa-project-id"`, reuse that project id for all Replay QA work in this repo. Do not create a duplicate project unless the user explicitly asks for a new project or the stored project is proven invalid for the current account.

If the user gives a Replay QA dashboard URL, pass it directly to the script or pass its project id with `--project-id`. The scripts recognize project ids such as `proj-example` inside positional arguments, `--project-id`, `--project-url`, and `REPLAY_QA_PROJECT_ID`. An explicit project argument overrides `.replay/config.json`.

If there is no reusable project id, create a project with `bootstrap.js` or `full-qa.js`. The scripts write the new project id back to `.replay/config.json` while preserving unrelated keys:

```json
{
  "qa-project-id": "projectId"
}
```

When reporting setup, say whether the id was reused from `.replay/config.json`, passed explicitly, read from the environment, or created and written back.

## Target URLs

Use public or externally reachable URLs for the normal Replay QA workflow:

```bash
node "$SCRIPT_DIR/full-qa.js" https://pr-123--example.netlify.app "Run smoke QA across auth, onboarding, checkout, navigation, and persistence."
node "$SCRIPT_DIR/full-qa.js" https://staging.example.com "Test the release candidate."
node "$SCRIPT_DIR/full-qa.js" https://app.example.com "Regression test the production critical paths."
```

For local apps, pass a local URL such as `http://localhost:3000`; the project creation script sets `use_reverse_proxy=true` for local URLs. After project creation, run `reverse-proxy.js --wait` or follow the runbook printed by `full-qa.js` so Replay QA can reach the local app. If the user provides a public URL, pass `--public`.

## Scripts

Run scripts with Node from the project root:

```bash
node "$SCRIPT_DIR/full-qa.js" https://pr-123--example.netlify.app "Test the core user journeys."
```

Available scripts:

| Script | Purpose |
| --- | --- |
| `bootstrap.js` | Create or reuse a project, then show details, status, and reverse-proxy setup. |
| `context.js` | Print concise current project context, status, and open bug summaries. |
| `full-qa.js` | Create or reuse a project, show status, show reverse-proxy setup, fetch open bug details, and print next steps. |
| `status.js` | Show project status; pass `--watch` to poll. |
| `reverse-proxy.js` | Show reverse-proxy setup; pass `--wait` to poll until instructions are ready. |
| `explorations.js` | List explorations. |
| `start-exploration.js` | Start a focused exploration only when the user asks for one. |
| `journeys.js` | List journeys or filter locally with `--journey-id`. |
| `test-runs.js` | List test runs; pass `--journey-id` to review a single journey's run history. |
| `bugs.js` | List bugs; use `--status`, `--details`, and `--save`. |
| `bug.js` | Fetch one bug by id. |
| `mark-bug.js` | Mark a bug `fixed`, `wontfix`, `invalid`, or `reopened`. Marking `fixed` automatically retries the affected journey. |
| `report-missing-bug.js` | Report a missing bug and ask Replay QA to create an investigation journey. |
| `rerun-journeys.js` | Expose supported journey retry alternatives because there is no direct single-journey rerun endpoint. |

List scripts print normalized JSON for agent use. For example, `bugs.js` returns a top-level `bugs` array even when the API response uses `items`. Pass `--raw` to `bugs.js` if you need the unmodified API list response.

Common examples:

```bash
node "$SCRIPT_DIR/full-qa.js" https://pr-123--example.netlify.app
node "$SCRIPT_DIR/status.js" --watch
node "$SCRIPT_DIR/bugs.js" "https://qa.replay.io/projects/proj-example/bugs"
node "$SCRIPT_DIR/bugs.js" --status open --details --save
node "$SCRIPT_DIR/bug.js" bug_id_here --save
node "$SCRIPT_DIR/mark-bug.js" bug_id_here fixed
node "$SCRIPT_DIR/start-exploration.js" "Focus on onboarding, invalid inputs, refreshes, and back navigation."
node "$SCRIPT_DIR/rerun-journeys.js" --bug-id bug_id_here
node "$SCRIPT_DIR/report-missing-bug.js" "Settings changes do not persist after refresh."
```

## Agent Workflow

Use this loop for QA and repair:

1. Start or confirm the app under test and verify the exact URL.
2. Run `full-qa.js` with the target URL and any user instructions.
3. If reverse-proxy instructions are returned, run them from a machine that can reach the app.
4. Poll `status.js` until there is useful progress.
5. Fetch open bug details with `bugs.js --status open --details --save`.
6. Read the full bug report before editing code. Use Replay QA's reproduction steps, expected behavior, actual behavior, evidence, and root-cause analysis as the primary debugging source.
7. Fix the codebase.
8. Mark each fixed bug with `mark-bug.js <bug-id> fixed`; Replay QA automatically retries the affected journey.
9. Poll status and list open bugs again.
10. Repeat until no open bugs remain or the remaining findings are explicitly accepted.

Do not manually start new explorations unless the user asks. Project creation already starts the normal QA workflow.

## Journey Reruns

The current OpenAPI spec exposes journeys and test runs, but it does not expose a direct endpoint to manually run one journey. Use these supported alternatives:

1. To inspect prior runs for a journey, run `test-runs.js --journey-id <journey-id>`.
2. To verify a bug fix, run `mark-bug.js <bug-id> fixed`; Replay QA automatically retries the affected journey.
3. To investigate a missed scenario, run `report-missing-bug.js "<description>"`; Replay QA creates an investigation journey.

Do not claim that a journey was manually rerun unless one of the supported flows actually triggered verification.
