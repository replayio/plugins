---
name: "replay-qa-api"
description: "Use when calling Replay QA's REST API directly from an Obvious agent. Covers direct API auth, Replay CLI token fallback, .replay/config.json project reuse, project creation from Replay recordings or target URLs, polling, bug retrieval, journeys, test runs, explorations, and Obvious artifact opening. This skill is instructions-only and does not use MCP, hooks, scripts, app bindings, or the general Replay.io setup skill."
---

# Replay QA API

Use the Replay QA REST API directly. This Obvious plugin is skills-only: do not call MCP tools, app connectors, hooks, or bundled scripts for Replay QA work.

This bundle intentionally installs only this direct API skill. It does not include the general Replay.io setup skill.

## Authentication

Replay QA API requests need a bearer token. Dedicated Replay QA tokens usually start with `lqa_`, but Replay CLI access tokens from `~/.replay/profile/auth.json` are also supported.

Look for a token in this order:

1. `REPLAY_QA_API_KEY`
2. `SECRET_REPLAY_QA_API_KEY`
3. `REPLAY_API_KEY`
4. `SECRET_REPLAY_API_KEY`
5. `REPLAY_ACCESS_TOKEN`
6. `~/.replay/profile/auth.json`, created by `npx replayio login`

Never print the token and do not run these commands with shell tracing enabled.

```bash
set +x

if [ -z "${REPLAY_QA_API_KEY:-}" ]; then
  for key_name in REPLAY_QA_API_KEY SECRET_REPLAY_QA_API_KEY REPLAY_API_KEY SECRET_REPLAY_API_KEY REPLAY_ACCESS_TOKEN; do
    key_value="$(printenv "$key_name" 2>/dev/null || true)"
    if [ -n "$key_value" ]; then
      export REPLAY_QA_API_KEY="$key_value"
      break
    fi
  done
fi

if [ -z "${REPLAY_QA_API_KEY:-}" ] && [ -f "$HOME/.replay/profile/auth.json" ]; then
  export REPLAY_QA_API_KEY="$(node -e 'const fs = require("fs"); const file = `${process.env.HOME}/.replay/profile/auth.json`; const find = (value) => { if (!value || typeof value !== "object") return ""; if (typeof value.accessToken === "string" && value.accessToken.trim()) return value.accessToken.trim(); for (const child of Object.values(value)) { const found = find(child); if (found) return found; } return ""; }; try { process.stdout.write(find(JSON.parse(fs.readFileSync(file, "utf8")))); } catch {}')"
fi

test -n "${REPLAY_QA_API_KEY:-}"
```

If no token is available, piggyback on the Replay CLI login flow, then rerun the setup above:

```bash
npx replayio login
npx replayio whoami
```

If the API returns `401`, refresh the Replay CLI login or ask the user to provide a dedicated Replay QA token in `REPLAY_QA_API_KEY` or `SECRET_REPLAY_QA_API_KEY`.

## Base URL

Use the same API host as the Claude Code Replay QA plugin unless the environment explicitly overrides it:

```bash
export REPLAY_QA_API_BASE="${REPLAY_QA_API_BASE:-https://qa.replay.io/api/v1}"
```

All requests need:

```bash
-H "Authorization: Bearer $REPLAY_QA_API_KEY"
-H "Content-Type: application/json"
```

## Project Reuse

Before creating or selecting a Replay QA project, always inspect the current project root for `.replay/config.json`.

Resolve the project root with `git rev-parse --show-toplevel`; if that fails, use the current directory:

```bash
PROJECT_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
REPLAY_CONFIG_PATH="$PROJECT_ROOT/.replay/config.json"
```

Project id selection order:

1. Use an explicit user-provided Replay QA dashboard URL or project id.
2. Use `REPLAY_QA_PROJECT_ID` if it is set.
3. Reuse `.replay/config.json` when it contains a non-empty string property named `"qa-project-id"`.
4. Create a new project only when no reusable project id exists, the stored project is proven invalid for the current account, or the user explicitly asks for a new project.

Read the stored project id without requiring `jq`:

```bash
PROJECT_ID="${REPLAY_QA_PROJECT_ID:-}"

if [ -z "$PROJECT_ID" ] && [ -f "$REPLAY_CONFIG_PATH" ]; then
  PROJECT_ID="$(node -e 'const fs = require("fs"); try { const config = JSON.parse(fs.readFileSync(process.argv[1], "utf8")); const id = config["qa-project-id"]; if (typeof id === "string") process.stdout.write(id.trim()); } catch {}' "$REPLAY_CONFIG_PATH")"
fi
```

If the user gives a dashboard URL, extract the `proj-...` id from it and treat that explicit id as overriding `.replay/config.json`.

When reporting setup, say whether the id was reused from `.replay/config.json`, passed explicitly, read from the environment, or created and written back.

## Save New Project IDs

After creating a project, extract the returned id and write it to `.replay/config.json` while preserving unrelated keys. Do not overwrite a different existing `"qa-project-id"` unless the user explicitly asked to switch projects.

```bash
PROJECT_ID="$(node -e 'const fs = require("fs"); const response = JSON.parse(fs.readFileSync("replay-qa-project.json", "utf8")); const id = response.project_id || response.id || response.project?.id || response.project?.project_id || ""; if (id) process.stdout.write(id);')"

test -n "$PROJECT_ID"
mkdir -p "$(dirname "$REPLAY_CONFIG_PATH")"

node -e 'const fs = require("fs"); const configPath = process.argv[1]; const projectId = process.argv[2]; let config = {}; try { config = JSON.parse(fs.readFileSync(configPath, "utf8")); } catch {} const existing = typeof config["qa-project-id"] === "string" ? config["qa-project-id"].trim() : ""; if (existing && existing !== projectId) throw new Error(`Existing qa-project-id ${existing} differs from new project ${projectId}`); config["qa-project-id"] = projectId; fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);' "$REPLAY_CONFIG_PATH" "$PROJECT_ID"
```

## Open An Obvious Artifact

Whenever you receive, reuse, or create a Replay QA project id, create an Obvious iframe artifact pointing to the project overview:

```text
https://qa.replay.io/p/${PROJECT_ID}/overview
```

If the API response also includes a dashboard URL, report both the artifact URL and the returned URL. The artifact URL is still the Obvious-friendly way to open the project from the agent workspace.

## Create A Project From A Replay Recording

Use this when you already have an uploaded Replay recording UUID. When `recording_id` is present, `target_url` is not required.

Required input:

- `name`: clear project or scenario name.
- `recording_id`: Replay recording UUID.
- `instructions`: include the raw test source URL when possible and the exact failure message/stack.
- `webhook_url`: optional.

```bash
curl -sS -X POST "$REPLAY_QA_API_BASE/projects" \
  -H "Authorization: Bearer $REPLAY_QA_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "S01 - checkout total does not update",
    "recording_id": "00000000-0000-0000-0000-000000000000",
    "instructions": "Analyze this Replay recording of a failing automated test.\n\nTest source:\nhttps://raw.githubusercontent.com/org/repo/refs/heads/branch/tests/checkout.spec.ts\n\nError:\nExpected checkout total to update after clicking Confirm Checkout.\n\nExplain the root cause and the code change that should fix it."
  }' | tee replay-qa-project.json >/dev/null
```

Save the returned project id, write it to `.replay/config.json`, and open the Obvious artifact.

## Create A Project For Live App Exploration

Use this when Replay QA should explore an app URL instead of analyzing one recording.

For public hosted Obvious URLs, pass the hosted URL as `target_url`:

```bash
curl -sS -X POST "$REPLAY_QA_API_BASE/projects" \
  -H "Authorization: Bearer $REPLAY_QA_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Todo app smoke exploration",
    "target_url": "https://example-obvious-app.hosted.obvious.ai",
    "instructions": "Explore the main user flows and report correctness, polish, and UX bugs."
  }' | tee replay-qa-project.json >/dev/null
```

## Poll Project Status

Poll every 30 seconds until the project reports completion. Status can be returned either at the top level or under `project.status`, so inspect the response shape instead of assuming one field.

```bash
curl -sS "$REPLAY_QA_API_BASE/projects/$PROJECT_ID/status" \
  -H "Authorization: Bearer $REPLAY_QA_API_KEY"
```

For long-running analysis, report that Replay QA is still processing rather than guessing from partial data.

## Fetch Bugs

List bugs:

```bash
curl -sS "$REPLAY_QA_API_BASE/projects/$PROJECT_ID/bugs?page_size=100" \
  -H "Authorization: Bearer $REPLAY_QA_API_KEY"
```

Filter open bugs:

```bash
curl -sS "$REPLAY_QA_API_BASE/projects/$PROJECT_ID/bugs?status=open&page_size=100" \
  -H "Authorization: Bearer $REPLAY_QA_API_KEY"
```

Fetch full bug detail:

```bash
BUG_ID="..."

curl -sS "$REPLAY_QA_API_BASE/bugs/$BUG_ID" \
  -H "Authorization: Bearer $REPLAY_QA_API_KEY"
```

Use bug detail as the source of truth for root cause, reproduction steps, expected behavior, actual behavior, severity, and Replay evidence.

After fixing a bug, mark it fixed so Replay QA automatically retries the affected journey:

```bash
curl -sS -X PATCH "$REPLAY_QA_API_BASE/bugs/$BUG_ID" \
  -H "Authorization: Bearer $REPLAY_QA_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"status":"fixed"}'
```

Allowed bug statuses are `fixed`, `wontfix`, `invalid`, and `reopened`.

## Journeys, Test Runs, And Explorations

List journeys:

```bash
curl -sS "$REPLAY_QA_API_BASE/projects/$PROJECT_ID/journeys?page_size=100" \
  -H "Authorization: Bearer $REPLAY_QA_API_KEY"
```

List test runs:

```bash
curl -sS "$REPLAY_QA_API_BASE/projects/$PROJECT_ID/test-runs?page_size=100" \
  -H "Authorization: Bearer $REPLAY_QA_API_KEY"
```

List explorations:

```bash
curl -sS "$REPLAY_QA_API_BASE/projects/$PROJECT_ID/explorations?page_size=100" \
  -H "Authorization: Bearer $REPLAY_QA_API_KEY"
```

Start another exploration only when the user asks for one:

```bash
curl -sS -X POST "$REPLAY_QA_API_BASE/projects/$PROJECT_ID/explorations" \
  -H "Authorization: Bearer $REPLAY_QA_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "prompt": "Re-test checkout, saved drafts, and navigation edge cases.",
    "agent_count": 3
  }'
```

`agent_count` must be between 1 and 10. Project creation already starts the normal QA workflow, so do not manually start extra explorations unless the user asks.

## Journey Reruns

The current API exposes journeys and test runs, but it does not expose a direct endpoint to manually run one journey. Use these supported alternatives:

1. To inspect prior runs for a journey, request `/projects/$PROJECT_ID/test-runs?journey_id=<journey-id>` if the API supports that query, or list test runs and filter locally.
2. To verify a bug fix, patch the bug status to `fixed`; Replay QA automatically retries the affected journey.
3. To investigate a missed scenario, create a focused exploration only when the user asks for one.

Do not claim that a journey was manually rerun unless one of the supported flows actually triggered verification.

## Fix Workflow Discipline

When Replay QA is used to guide fixes:

1. Start or confirm the app under test.
2. Reuse the project id from `.replay/config.json` when present.
3. Create a new Replay QA project only when needed.
4. Open the Obvious iframe artifact for the project overview.
5. If reverse-proxy instructions are returned, run them from an environment that can reach the app.
6. Poll project status until there is useful progress.
7. Fetch full open bug details.
8. Read the full bug report before editing code. Use Replay QA's reproduction steps, expected behavior, actual behavior, evidence, and root-cause analysis as the primary debugging source.
9. Patch only from Replay QA evidence plus the current source file.
10. Mark each fixed bug with `PATCH /bugs/{bug_id}` and status `fixed`.
11. Poll status and list open bugs again.
12. Repeat until no open bugs remain or report the remaining blocker.

Do not infer a root cause from source reading while Replay QA analysis is still pending.

## API Reference

Key endpoints:

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/projects` | List projects |
| `POST` | `/projects` | Create a recording-analysis or app-exploration project |
| `GET` | `/projects/{project_id}` | Get project details |
| `GET` | `/projects/{project_id}/status` | Get project summary/status |
| `GET` | `/projects/{project_id}/reverse-proxy` | Get reverse-proxy setup for local apps |
| `GET` | `/projects/{project_id}/bugs` | List bugs |
| `GET` | `/bugs/{bug_id}` | Get bug detail |
| `PATCH` | `/bugs/{bug_id}` | Update bug status |
| `GET` | `/projects/{project_id}/journeys` | List journeys |
| `GET` | `/projects/{project_id}/test-runs` | List test runs |
| `GET` | `/projects/{project_id}/explorations` | List explorations |
| `POST` | `/projects/{project_id}/explorations` | Start a new exploration |

OpenAPI spec:

```text
https://qa.replay.io/api/v1/openapi.json
```

## Reporting

When reporting Replay QA API work, include:

- Project ID and URL, if returned.
- Whether the project id came from an explicit input, environment variable, `.replay/config.json`, or new project creation.
- The Obvious artifact URL that was opened or created.
- Recording ID or target URL analyzed.
- Reverse-proxy status when the target URL is local.
- Status response summary.
- Bug count and each bug ID inspected.
- Root cause and recommended fix from bug detail.
- Any 401, 404, rate limit, missing-token, or incomplete-analysis blocker.
