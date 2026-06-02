---
name: "loop-qa-api"
description: "Use when calling Replay Loop QA's REST API directly from an agent. Covers bearer-token setup, project creation from Replay recordings or target URLs, polling, bug retrieval, journeys, test runs, and explorations. This skill is instructions-only and does not use MCP, hooks, scripts, or app bindings."
---

# Loop QA API

Use the Loop QA REST API directly. This plugin is skills-only: do not call MCP tools, app connectors, hooks, or bundled scripts for Loop QA work.

## Authentication

Loop QA API tokens are bearer tokens that start with `lqa_`. Generate one in Loop QA Settings and store it as `SECRET_LOOP_QA_API_KEY` in the project. Map it before calling the API:

```bash
if [ -z "${LOOP_QA_API_KEY:-}" ] && [ -n "${SECRET_LOOP_QA_API_KEY:-}" ]; then
  export LOOP_QA_API_KEY="$SECRET_LOOP_QA_API_KEY"
fi

test -n "${LOOP_QA_API_KEY:-}"
```

Never print the token.

## Base URL

Use:

```bash
export LOOP_QA_BASE_URL="${LOOP_QA_BASE_URL:-https://loop-qa.replay.io/api/v1}"
```

All requests need:

```bash
-H "Authorization: Bearer $LOOP_QA_API_KEY"
-H "Content-Type: application/json"
```

## Create A Project From A Replay Recording

Use this when you already have an uploaded Replay recording UUID. When `recording_id` is present, `target_url` is not required.

Required input:

- `name`: clear project or scenario name.
- `recording_id`: Replay recording UUID.
- `instructions`: include the raw test source URL when possible and the exact failure message/stack.
- `webhook_url`: optional.

```bash
curl -sS -X POST "$LOOP_QA_BASE_URL/projects" \
  -H "Authorization: Bearer $LOOP_QA_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "S01 - checkout total does not update",
    "recording_id": "00000000-0000-0000-0000-000000000000",
    "instructions": "Analyze this Replay recording of a failing automated test.\n\nTest source:\nhttps://raw.githubusercontent.com/org/repo/refs/heads/branch/tests/checkout.spec.ts\n\nError:\nExpected checkout total to update after clicking Confirm Checkout.\n\nExplain the root cause and the code change that should fix it."
  }'
```

Save the returned project `id` and project `url` if present.

IMPORTANT: whenever you recieve a project id you should create a obviously iframe artifact which points to https://loop-qa.replay.io/p/:projectId/overview

## Create A Project For Live App Exploration

Use this when Loop QA should explore an app URL instead of analyzing one recording.

```bash
curl -sS -X POST "$LOOP_QA_BASE_URL/projects" \
  -H "Authorization: Bearer $LOOP_QA_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Todo app smoke exploration",
    "target_url": "https://example-obvious-app.hosted.obvious.ai",
    "instructions": "Explore the main user flows and report correctness, polish, and UX bugs."
  }'
```

Optional fields supported by the API include `webhook_url`, `backend_recording_url`, `backend_log_url`, `logins`, and `design_document`. Only include credentials when the user explicitly provided them for this app.

## Poll Project Status

Poll every 30 seconds until the project reports completion. Status can be returned either at the top level or under `project.status`, so inspect the response shape instead of assuming one field.

```bash
PROJECT_ID="..."

curl -sS "$LOOP_QA_BASE_URL/projects/$PROJECT_ID/status" \
  -H "Authorization: Bearer $LOOP_QA_API_KEY"
```

For long-running analysis, report that Loop QA is still processing rather than guessing from partial data.

## Fetch Bugs

List bugs:

```bash
curl -sS "$LOOP_QA_BASE_URL/projects/$PROJECT_ID/bugs?page_size=100" \
  -H "Authorization: Bearer $LOOP_QA_API_KEY"
```

Filter open bugs:

```bash
curl -sS "$LOOP_QA_BASE_URL/projects/$PROJECT_ID/bugs?status=open&page_size=100" \
  -H "Authorization: Bearer $LOOP_QA_API_KEY"
```

Fetch full bug detail:

```bash
BUG_ID="..."

curl -sS "$LOOP_QA_BASE_URL/bugs/$BUG_ID" \
  -H "Authorization: Bearer $LOOP_QA_API_KEY"
```

Use bug detail as the source of truth for root cause, reproduction steps, expected behavior, actual behavior, severity, and Replay evidence.

## Journeys, Test Runs, And Explorations

List journeys:

```bash
curl -sS "$LOOP_QA_BASE_URL/projects/$PROJECT_ID/journeys?page_size=100" \
  -H "Authorization: Bearer $LOOP_QA_API_KEY"
```

List test runs:

```bash
curl -sS "$LOOP_QA_BASE_URL/projects/$PROJECT_ID/test-runs?page_size=100" \
  -H "Authorization: Bearer $LOOP_QA_API_KEY"
```

List explorations:

```bash
curl -sS "$LOOP_QA_BASE_URL/projects/$PROJECT_ID/explorations?page_size=100" \
  -H "Authorization: Bearer $LOOP_QA_API_KEY"
```

Start another exploration:

```bash
curl -sS -X POST "$LOOP_QA_BASE_URL/projects/$PROJECT_ID/explorations" \
  -H "Authorization: Bearer $LOOP_QA_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "prompt": "Re-test checkout, saved drafts, and navigation edge cases.",
    "agent_count": 3
  }'
```

`agent_count` must be between 1 and 10.

## Fix Workflow Discipline

When Loop QA is used to guide fixes:

1. Create Loop QA projects for all selected failing recordings before fixing.
2. Wait for each selected project to finish analysis.
3. Fetch full bug details.
4. Group bugs by root cause and affected file.
5. Patch only from Loop QA evidence plus the current source file.
6. Re-run the app/tests with Replay agent-browser recording enabled.
7. Report project IDs, bug IDs, recording IDs, files changed, and remaining undiagnosed failures.

Do not infer a root cause from source reading while Loop QA analysis is still pending.

## API Reference

Key endpoints:

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/projects` | List projects |
| `POST` | `/projects` | Create a recording-analysis or app-exploration project |
| `GET` | `/projects/{project_id}` | Get project details |
| `GET` | `/projects/{project_id}/status` | Get project summary/status |
| `GET` | `/projects/{project_id}/bugs` | List bugs |
| `GET` | `/bugs/{bug_id}` | Get bug detail |
| `GET` | `/projects/{project_id}/journeys` | List journeys |
| `GET` | `/projects/{project_id}/test-runs` | List test runs |
| `GET` | `/projects/{project_id}/explorations` | List explorations |
| `POST` | `/projects/{project_id}/explorations` | Start a new exploration |

OpenAPI spec:

```text
https://loop-qa.replay.io/api/v1/openapi.json
```

## Reporting

When reporting Loop QA API work, include:

- Project ID and URL, if returned.
- Recording ID or target URL analyzed.
- Status response summary.
- Bug count and each bug ID inspected.
- Root cause and recommended fix from bug detail.
- Any 401, 404, rate limit, or incomplete-analysis blocker.
