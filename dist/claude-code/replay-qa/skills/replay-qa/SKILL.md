---
name: "replay-qa"
description: "Use when handing Replay recordings or app URLs to Replay QA from Claude Code. Prefer Replay MCP OAuth/browser handoff over direct REST calls. Covers authenticated dashboard and Replay QA links, project handoff, evidence capture, and fix workflow discipline."
---

# Replay QA Handoff

Use Replay QA through the authenticated Replay QA web surfaces and Replay MCP account context whenever possible. Do not default to raw Replay QA REST API calls or separate `lqa_` bearer tokens.

## Claude Code Prerequisite

Before using Replay QA, make sure the Claude Code plugin has been loaded for the current session and its plugin-root `.mcp.json` is active.

Verify:

- Replay MCP is connected through the plugin-root `.mcp.json` and authenticated as the Replay account that owns the recording.
- `AGENT_BROWSER_EXECUTABLE_PATH` points at Replay Chromium.
- `RECORD_ALL_CONTENT` and `RECORD_REPLAY_VERBOSE` are set.
- Any Replay recording referenced by Replay QA has uploaded or has a concrete recording UUID.

If the plugin or MCP setup is unknown, stop and have the user start Claude Code from the project root. The installed shadcn docs show the fallback command:

```bash
claude --plugin-dir .claude/skills/replay-qa
```

Do not proceed with Replay QA handoff until the plugin MCP server is available.

## Project Config Reuse

Before creating or selecting a Replay QA project, inspect the current project root for `.replay/config.json`.

Resolve the project root with `git rev-parse --show-toplevel` when the working directory is inside a git repo; otherwise use the current working directory. Then:

1. If `.replay/config.json` exists and contains a non-empty string property named `"qa-project-id"`, reuse that project ID for all Replay QA work in this project from that point on.
2. Do not call `create_project` when a valid `"qa-project-id"` already exists unless the user explicitly asks for a new Replay QA project or the existing project is proven invalid for the current account.
3. If `.replay/config.json` is missing, invalid, or does not contain `"qa-project-id"`, use the Replay QA MCP `create_project` tool to create a project.
4. After `create_project` returns the project ID, create or update `.replay/config.json` so future runs can reuse it:

```json
{
  "qa-project-id": "projectId"
}
```

Preserve any unrelated keys already present in `.replay/config.json`. Create the `.replay/` directory if needed. Keep the file valid JSON. Do not overwrite an existing `"qa-project-id"` with a different ID without user confirmation.

When reporting Replay QA setup, say whether the project ID was reused from `.replay/config.json` or created with `create_project` and written back to the config file.

## Authentication

Prefer the Replay MCP OAuth token/session. If Claude Code or the MCP host exposes the Replay OAuth access token through an approved mechanism, reuse it for first-party web handoff links instead of asking for a separate Replay QA API key.

Append the token as a URL fragment:

```text
#access_token=<oauth-access-token>
```

Use this only on first-party Replay URLs:

- `https://app.replay.io/...`
- `https://loop-qa.replay.io/...`

Do not use `access_token` as a query parameter. Do not attach it to third-party URLs. Do not print the raw token by itself, store it in files, commit it, or log it. If the OAuth token is unavailable to the agent, use a normal first-party URL and tell the user to sign in or reconnect Replay MCP for the correct account.

Do not ask the user to generate a `LOOP_QA_API_KEY` unless they explicitly ask for direct API fallback and MCP/browser auth cannot satisfy the task.

## Authenticated Links

When linking the user to the Replay dashboard or Replay QA, preserve the same account by adding `#access_token=` when an MCP OAuth token is available.

Use this shape:

```text
https://app.replay.io/recording/<recording-id>#access_token=<oauth-access-token>
https://loop-qa.replay.io/p/<project-id>/overview#access_token=<oauth-access-token>
```

If the base URL already has a fragment, preserve useful navigation state by adding `&access_token=` when the fragment is parameter-style. If the existing fragment is not parameter-style, use a clean Replay dashboard or Replay QA overview URL with `#access_token=` for the handoff instead of corrupting the navigation fragment. Keep the token out of prose summaries and shell output; use it only in the first-party URL that the user or browser will open.

## Handoff From A Replay Recording

Use this when you already have an uploaded Replay recording UUID.

Capture:

- Recording UUID and uploaded Replay URL.
- Clear project or scenario name.
- Exact failure message or stack.
- Test source URL when available.
- Instructions for the analysis, including what the user expects Replay QA to answer.

Prefer the project ID from `.replay/config.json`. If none exists, use the Replay QA MCP `create_project` tool, then write the returned project ID to `.replay/config.json`. If no MCP tool or browser workflow is available to create the project, give the user the authenticated Replay dashboard link and the exact instructions to paste into Replay QA.

When a Replay QA project ID or URL is available, provide the Replay QA overview link. Add `#access_token=` only when the OAuth token is available from the MCP/host session.

## Handoff For Live App Exploration

Use this when Replay QA should explore an app URL instead of analyzing one recording.

Replay QA needs a public HTTPS target URL because the service runs outside the user's machine. Do not use `localhost`, `127.0.0.1`, private LAN, or VPN-only URLs as the target.

If the app is local, expose it first:

```bash
netlify dev --live
```

Or, for a generic dev server:

```bash
ngrok http <port>
```

Keep the dev server and tunnel running while Replay QA explores. Use the public `https://...` URL printed by Netlify or ngrok as the target URL, then verify it responds before handoff:

```bash
curl -I "https://your-public-url.example"
```

Capture:

- Target URL.
- Scenario name.
- User-provided credentials or login instructions, only if explicitly provided for this app.
- Exploration goals, expected behavior, and important user flows.
- Related Replay recording IDs, backend recording URLs, backend log URLs, or design documents when available.

Prefer the project ID from `.replay/config.json`. If none exists, use the Replay QA MCP `create_project` tool, then write the returned project ID to `.replay/config.json`. If creation is not available from the current tools, provide a concise handoff: target URL, instructions, and the authenticated Replay QA link when available.

## Project Status And Evidence

Use the Replay QA web UI, Replay MCP widgets/tools, or returned project URLs as the source of truth for status and evidence. For long-running analysis, report that Replay QA is still processing rather than guessing from partial data.

When Replay QA finds bugs, capture:

- Project ID and URL.
- Bug ID or stable bug URL.
- Root cause.
- Reproduction steps.
- Expected and actual behavior.
- Severity.
- Replay evidence and any relevant dashboard links.

## Direct API Fallback

Use direct Replay QA REST calls only when the user explicitly asks for API-level work or when the first-party UI/MCP path is unavailable and the task cannot proceed otherwise. In that fallback, prefer an OAuth token already available from the Replay MCP account if the API accepts it. Only request a separate Replay QA API key when OAuth is unavailable or not accepted.

## Fix Workflow Discipline

When Replay QA is used to guide fixes:

1. Create or identify Replay QA projects for all selected failing recordings before fixing.
2. Wait for each selected project to finish analysis.
3. Fetch full bug details.
4. Group bugs by root cause and affected file.
5. Patch only from Replay QA evidence plus the current source file.
6. Re-run the app or tests and capture fresh evidence.
7. Report project IDs, bug IDs, recording IDs, files changed, and remaining undiagnosed failures.

Do not infer a root cause from source reading while Replay QA analysis is still pending.

## Reporting

When reporting Replay QA work, include:

- Project ID and URL, if returned.
- Whether the project ID was reused from `.replay/config.json` or created and written there.
- Recording ID or target URL analyzed.
- Status summary.
- Bug count and each bug ID inspected.
- Root cause and recommended fix from bug detail.
- Whether an authenticated `#access_token=` handoff link was used. Do not include the raw token separately.
- Any account mismatch, unavailable OAuth token, or incomplete-analysis blocker.
