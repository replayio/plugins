---
name: "loop-qa-api"
description: "Use when handing Replay recordings or app URLs to Loop QA from Claude Code. Prefer Replay MCP OAuth/browser handoff over direct REST calls. Covers authenticated dashboard and Loop QA links, project handoff, evidence capture, and fix workflow discipline."
---

# Loop QA Handoff

Use Loop QA through the authenticated Replay/Loop QA web surfaces and Replay MCP account context whenever possible. Do not default to raw Loop QA REST API calls or separate `lqa_` bearer tokens.

## Replay.io Skill Prerequisite

Before using Loop QA, make sure the `replayio` skill in this same Claude Code plugin bundle has been loaded and applied for the current session.

If setup is unknown, load `../replayio/SKILL.md` first and follow it before continuing. In particular, verify:

- Replay MCP is connected through the plugin-root `.mcp.json` and authenticated as the Replay account that owns the recording.
- `AGENT_BROWSER_EXECUTABLE_PATH` points at Replay Chromium.
- `RECORD_ALL_CONTENT` and `RECORD_REPLAY_VERBOSE` are set.
- Any Replay recording referenced by Loop QA has uploaded or has a concrete recording UUID.

Do not proceed with Loop QA handoff if this prerequisite is unknown. Load and apply the `replayio` skill first, then return to this skill.

## Authentication

Prefer the Replay MCP OAuth token/session. If Claude Code or the MCP host exposes the Replay OAuth access token through an approved mechanism, reuse it for first-party web handoff links instead of asking for a separate Loop QA API key.

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

When linking the user to the Replay dashboard or Loop QA, preserve the same account by adding `#access_token=` when an MCP OAuth token is available.

Use this shape:

```text
https://app.replay.io/recording/<recording-id>#access_token=<oauth-access-token>
https://loop-qa.replay.io/p/<project-id>/overview#access_token=<oauth-access-token>
```

If the base URL already has a fragment, preserve useful navigation state by adding `&access_token=` when the fragment is parameter-style. If the existing fragment is not parameter-style, use a clean Replay dashboard or Loop QA overview URL with `#access_token=` for the handoff instead of corrupting the navigation fragment. Keep the token out of prose summaries and shell output; use it only in the first-party URL that the user or browser will open.

## Handoff From A Replay Recording

Use this when you already have an uploaded Replay recording UUID.

Capture:

- Recording UUID and uploaded Replay URL.
- Clear project or scenario name.
- Exact failure message or stack.
- Test source URL when available.
- Instructions for the analysis, including what the user expects Loop QA to answer.

Prefer a Replay MCP tool or first-party Loop QA/dashboard UI for creating or opening the Loop QA project. If no MCP tool or browser workflow is available to create the project, give the user the authenticated Replay dashboard link and the exact instructions to paste into Loop QA.

When a Loop QA project ID or URL is available, provide the Loop QA overview link. Add `#access_token=` only when the OAuth token is available from the MCP/host session.

## Handoff For Live App Exploration

Use this when Loop QA should explore an app URL instead of analyzing one recording.

Capture:

- Target URL.
- Scenario name.
- User-provided credentials or login instructions, only if explicitly provided for this app.
- Exploration goals, expected behavior, and important user flows.
- Related Replay recording IDs, backend recording URLs, backend log URLs, or design documents when available.

Prefer browser/UI or Replay MCP-supported project creation over direct REST calls. If creation is not available from the current tools, provide a concise handoff: target URL, instructions, and the authenticated Loop QA link when available.

## Project Status And Evidence

Use the Loop QA web UI, Replay MCP widgets/tools, or returned project URLs as the source of truth for status and evidence. For long-running analysis, report that Loop QA is still processing rather than guessing from partial data.

When Loop QA finds bugs, capture:

- Project ID and URL.
- Bug ID or stable bug URL.
- Root cause.
- Reproduction steps.
- Expected and actual behavior.
- Severity.
- Replay evidence and any relevant dashboard links.

## Direct API Fallback

Use direct Loop QA REST calls only when the user explicitly asks for API-level work or when the first-party UI/MCP path is unavailable and the task cannot proceed otherwise. In that fallback, prefer an OAuth token already available from the Replay MCP account if the API accepts it. Only request a separate Loop QA API key when OAuth is unavailable or not accepted.

## Fix Workflow Discipline

When Loop QA is used to guide fixes:

1. Create or identify Loop QA projects for all selected failing recordings before fixing.
2. Wait for each selected project to finish analysis.
3. Fetch full bug details.
4. Group bugs by root cause and affected file.
5. Patch only from Loop QA evidence plus the current source file.
6. Re-run the app or tests with Replay agent-browser recording enabled.
7. Report project IDs, bug IDs, recording IDs, files changed, and remaining undiagnosed failures.

Do not infer a root cause from source reading while Loop QA analysis is still pending.

## Reporting

When reporting Loop QA work, include:

- Project ID and URL, if returned.
- Recording ID or target URL analyzed.
- Status summary.
- Bug count and each bug ID inspected.
- Root cause and recommended fix from bug detail.
- Whether an authenticated `#access_token=` handoff link was used. Do not include the raw token separately.
- Any account mismatch, unavailable OAuth token, or incomplete-analysis blocker.
