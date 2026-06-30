---
name: "replay-qa"
description: "Managed E2E testing service for finding bugs and adversarial verification"
allowed-tools: Bash(node *)
---

# Replay QA

Use Replay QA through the bundled scripts in `${CLAUDE_SKILL_DIR}/scripts`. The scripts call the Replay QA HTTP API directly, preserve project state in the repo, and avoid requiring the model to remember raw endpoint details.

## Current Replay QA Context

This block is injected when the skill loads. If shell execution is disabled or auth is missing, use the error message to decide which setup step to run next.

```!
node "${CLAUDE_SKILL_DIR}/scripts/context.js" "$ARGUMENTS"
```

## Authentication

The scripts look for a token in this order:

1. `REPLAY_QA_API_KEY`
2. `REPLAY_API_KEY`
3. `REPLAY_ACCESS_TOKEN`
4. `~/.replay/profile/auth.json`

If the user is not logged in, run:

```bash
npx replayio login
npx replayio whoami
```

If the API returns 401, ask the user to export a Replay QA API token as `REPLAY_QA_API_KEY` or `REPLAY_API_KEY`.

## Project Reuse

Before creating or selecting a Replay QA project, always inspect the current project root for `.replay/config.json`.

Resolve the project root with `git rev-parse --show-toplevel`; if that fails, use the current directory. If `.replay/config.json` contains a non-empty string property named `"qa-project-id"`, reuse that project id for all Replay QA work in this repo. Do not create a duplicate project unless the user explicitly asks for a new project or the stored project is proven invalid for the current account.

If the user gives a Replay QA dashboard URL, pass it directly to the script or pass its project id with `--project-id`. The scripts recognize project ids such as `proj-example` inside positional arguments, `--project-id`, `--project-url`, and `REPLAY_QA_PROJECT_ID`. An explicit project argument overrides `.replay/config.json`.

If there is no reusable project id, create a project with `bootstrap.js` or `full-qa.js`. The scripts write the new project id back to `.replay/config.json` while preserving unrelated keys:

```json
{
  "qa-project-id": "projectId"
}
```

When reporting setup, say whether the id was reused from `.replay/config.json`, passed explicitly, read from the environment, or created and written back.

## Local Apps

Replay QA needs network access to the app under test. For local apps, pass a local URL such as `http://localhost:3000`; the project creation script sets `use_reverse_proxy=true` for local URLs. After project creation, run `reverse-proxy.js --wait` or follow the runbook printed by `full-qa.js` so Replay QA can reach the local app. If the user provides a public URL, pass `--public`.

## Scripts

Run scripts with Node from the project root:

```bash
node "${CLAUDE_SKILL_DIR}/scripts/full-qa.js" http://localhost:3000 "Test the core user journeys."
```

Available scripts:

| Script | Purpose |
| --- | --- |
| `bootstrap.js` | Create or reuse a project, then show details, status, and reverse-proxy setup. |
| `context.js` | Inject concise current project context, status, and open bug summaries into this skill. |
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
node "${CLAUDE_SKILL_DIR}/scripts/full-qa.js" http://localhost:3000
node "${CLAUDE_SKILL_DIR}/scripts/status.js" --watch
node "${CLAUDE_SKILL_DIR}/scripts/bugs.js" "https://qa.replay.io/projects/proj-example/bugs"
node "${CLAUDE_SKILL_DIR}/scripts/bugs.js" --status open --details --save
node "${CLAUDE_SKILL_DIR}/scripts/bug.js" bug_id_here --save
node "${CLAUDE_SKILL_DIR}/scripts/mark-bug.js" bug_id_here fixed
node "${CLAUDE_SKILL_DIR}/scripts/start-exploration.js" "Focus on onboarding, invalid inputs, refreshes, and back navigation."
node "${CLAUDE_SKILL_DIR}/scripts/rerun-journeys.js" --bug-id bug_id_here
node "${CLAUDE_SKILL_DIR}/scripts/report-missing-bug.js" "Settings changes do not persist after refresh."
```

## Slash Commands

This plugin also ships command files in the plugin `commands/` directory. Invoke them through the plugin namespace when available:

| Command | Purpose |
| --- | --- |
| `/replay-qa:run-full-qa` | Bootstrap or resume QA, show status, show reverse-proxy instructions, and fetch open bugs. |
| `/replay-qa:qa-status` | Show or watch project status. |
| `/replay-qa:qa-bugs` | Fetch open bug details for repair work. |
| `/replay-qa:start-new-exploration` | Start a focused exploration. |
| `/replay-qa:rerun-journeys` | Use supported journey retry alternatives. |
| `/replay-qa:report-missing-bug` | Ask Replay QA to investigate a missed issue. |

## Agent Workflow

Use this loop for QA and repair:

1. Start or confirm the app under test.
2. Run `full-qa.js` with the target URL and any user instructions.
3. If reverse-proxy instructions are returned, run them from a machine that can reach the app.
4. Poll `status.js` until there is useful progress.
5. Fetch open bug details with `bugs.js --status open --details --save`.
6. Read the full bug report before editing code. Use Replay QA's reproduction steps, expected behavior, actual behavior, evidence, and root-cause analysis as the primary debugging source.
7. Fix the codebase.
8. Mark each fixed bug with `mark-bug.js <bug-id> fixed`; Replay QA automatically retries the affected journey.
9. Poll status and list open bugs again.
10. Repeat until no open bugs remain.

Do not manually start new explorations unless the user asks. Project creation already starts the normal QA workflow.

## Journey Reruns

The current OpenAPI spec exposes journeys and test runs, but it does not expose a direct endpoint to manually run one journey. Use these supported alternatives:

1. To inspect prior runs for a journey, run `test-runs.js --journey-id <journey-id>`.
2. To verify a bug fix, run `mark-bug.js <bug-id> fixed`; Replay QA automatically retries the affected journey.
3. To investigate a missed scenario, run `report-missing-bug.js "<description>"`; Replay QA creates an investigation journey.

Do not claim that a journey was manually rerun unless one of the supported flows actually triggered verification.
