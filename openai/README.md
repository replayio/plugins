# Replay.io public directory release

This directory prepares an update to the existing **Replay.io** listing shared by
ChatGPT and Codex. `replayio/` is the uploadable package source. The surrounding
release tooling and this runbook stay outside its ZIP.

The preview requires [backend PR #13672](https://github.com/replayio/backend/pull/13672)
to be merged and deployed at `https://dispatch.replay.io/mcp`. Uploading a plugin
ZIP or installing a Git marketplace package does not deploy that backend.

## Release channels and existing UI

These are separate distributions:

| Item | Source | Purpose |
| --- | --- | --- |
| Replay.io | OpenAI public directory | Approved hosted MCP tools and UI |
| Replay.io Pro, `replayio@replayio-plugins` | Git marketplace | Local recording, MP4 workflows, and hosted debugging |
| Replay QA | Separate QA plugin | Projects, bugs, journeys, and explorations |

`codex/replayio/.app.json` refers to registered app
`asdk_app_69f2257291c881919607448f14509d37`. The Git package at `origin/main`
(`a0ca5d0`) calls itself **Replay.io Pro**, version 0.1.1. Its version is a
different release track from the public directory package. Installing it does
not update the published MCP definition or deploy its server.

Earlier rrweb players exist in `claude-code/replayio/live/` and are attached to
Claude Code tool rows by local hooks in `claude-code/replayio/hooks/register.tsx`.
`hooks/mcp/tools/overview.ts` renders an overview card. The Codex Pro skill also
describes rich widgets, but those instructions do not implement the hosted MCP
resource contract. In backend base `47b7f5eec47bbe7493e8f92698bd538dd3d60a88`,
`McpServerManager` registered tools without an overview UI resource. PR #13672
adds that resource, tool references, authenticated frame loading, and the player.
Use the authenticated server check below to verify the deployed metadata; an
anonymous `tools/list` request correctly returns 401.

## Release contents

The candidate is version **1.1.0** under the existing Replay.io identity. Confirm
the published version in the dashboard before upload and bump this candidate if
necessary. The manifest does not invent or replace a dashboard-assigned ID.

- Portable root `plugin.json`, listing metadata, release notes, and 5 positive /
  3 negative review cases.
- Root `mcp.json`, the existing HTTPS MCP URL and OAuth identity scopes. Endpoints
  and client registration remain discoverable; no client secret is packaged.
- A focused recording-debugging skill that works through hosted tools.
- The existing Replay logo centered on a square 128px SVG canvas, and the license.

The manual Pro package remains in `codex/replayio/`. It contains lifecycle hooks,
an `.app.json` reference, browser launch helpers, and ffmpeg workflows. Current
public submission rejects lifecycle hooks and app references; those components
are excluded from this store package. The store listing describes analysis of
uploaded recordings and does not promise local browser recording or MP4 export.
It does not require a local executor.

## Build and validate

Use Python 3 and Node.js 20 or newer for the release tools:

```sh
python3 openai/build-release.py --check
node --test openai/test-release.mjs
python3 openai/build-release.py
node openai/check-server.mjs
```

The builder creates `openai/dist/replayio-1.1.0.zip` and its SHA-256 checksum. It
checks listing limits, review case completeness, asset dimensions, the MCP URL
and scopes, and an exact file allowlist. It rejects hooks, app references,
credential fields, extra files, and symlinks. ZIP entries have stable timestamps,
ordering, and permissions. These are local checks, not OpenAI review approval.
The upstream Agent Plugins MCP 1.0.0 JSON schema does not recognize the OpenAI
`extensions.com.openai.auth` fields documented by OpenAI. Validate those fields
with the OpenAI reference and dashboard scans; a generic MCP schema check alone
cannot validate the complete OpenAI submission configuration.

The initial ZIP omits `demo_recording_url` because no walkthrough URL has been
verified for this release. Omission preserves any existing dashboard value.
After recording and verifying the walkthrough, include its actual HTTPS URL:

```sh
python3 openai/build-release.py --demo-url "$REPLAYIO_REVIEW_DEMO_URL"
```

The server check first verifies public OAuth discovery, PKCE S256 advertisement,
and a 401 challenge for anonymous requests. With a valid reviewer-account access
token supplied securely in `REPLAYIO_MCP_TOKEN`, it also checks the live tool
catalog and UI HTML/CSP. Optional recording arguments exercise real frame
pagination, the non-browser empty state, and recording access denial:

```sh
node openai/check-server.mjs \
  --recording-id "$REPLAYIO_REVIEW_BROWSER_RECORDING_ID" \
  --node-recording-id "$REPLAYIO_REVIEW_NODE_RECORDING_ID" \
  --denied-recording-id "$REPLAYIO_REVIEW_DENIED_RECORDING_ID"
```

Supply tokens through your local secret manager or secure environment; do not
paste them into chat, commit them, or put them in the ZIP. The script never logs
tokens or recording contents and refuses redirects on authenticated requests.
Use `--endpoint https://…/mcp` for a staging endpoint when appropriate. Read-only
MCP calls may take several minutes on a cold recording. This check verifies the
server contract; the host UI and all eight review cases still need manual runs.

Backend verification commands, from the backend checkout:

```sh
pnpm exec vitest run src/analysis/execution-data/recordingPreview.test.ts src/analysis/execution-data/processorServerUtils.test.ts src/agent/nut/recordingRequest.test.ts
pnpm exec tsx scripts/analysis/verify-recording-preview.cjs
```

The browser smoke uses synthetic data and a host fixture. It is useful evidence
for player controls, masking, both UI bridges, resizing, retry, and empty/error
states. It does not prove that production recordings can be evaluated by the
native Replay engine or that the store host has approved the tool changes.

## Reviewer account and fixtures

Reuse the existing dedicated reviewer setup if it still works. Otherwise prepare
a sample-data account through the normal Replay account administration flow.
The account must sign in immediately without inaccessible MFA approvals, email
codes, magic links, a private network, or a production user's credentials.

Put the following in the dashboard's secure **Review details** form, not in the
package or repository:

- Login URL, dedicated account credentials, workspace name, and exact sign-in steps.
- **Browser recording:** an uploaded, accessible React recording with at least
  three distinct visible states, a synthetic `console.error`, a failed network
  request, and several React renders. Include a password input with synthetic
  data to check masking. Record the expected visible states, console message,
  request status, and component names from that recording as reference evidence.
- **Node recording:** a separate accessible recording without a browser DOM.
- **Access-denied recording:** a private recording owned by a different test
  account, without sharing it with the reviewer account. Prime its overview and
  preview cache using the authorized test account, then check denial using the
  reviewer account. Do not change customer recording permissions for this test.
- Identify these three URLs using the same labels as the manifest's review cases.

Run P1–P5 and N1–N3 from `replayio/plugin.json` with this account in a supported
OpenAI host after deploying and scanning. Use `review-results.template.json` as a
local results record. Record date, host, deployed revision, observed outcome and
evidence for each case. All cases are **not run** until that evidence exists.
Include light and dark themes, keyboard play/pause, a narrow window, denied
access, a retryable server error, and a host without embedded UI. Confirm that
snapshots, signed URLs, or user tokens never appear in model-visible preview text.

Record a reviewer-accessible walkthrough showing sign-in, P1 overview/preview,
P2 play/pause/seek/speed/open link, P3 failures, P4 React evidence, P5 Node empty
state, and the negative cases. Use synthetic fixture data. Check the walkthrough
link in a signed-out session with the access method given to reviewers. Keep the
account, recordings, and walkthrough available for subsequent reviews.

## Update the existing listing

1. Open [OpenAI Plugins](https://platform.openai.com/plugins) in the organization
   and project owning the existing Replay.io listing. Verify developer identity,
   project eligibility, and Apps Management write access. Download the published
   ZIP and compare its identity, existing review materials, and connection
   settings with this candidate. Preserve country availability and translations
   unless there is an intended change; this package omits both fields.
2. Merge/deploy backend PR #13672 through the backend's normal release process.
   Preserve `https://dispatch.replay.io/mcp`. Run authenticated staging and
   production checks with the sample fixtures. The preview resource must be
   `ui://replay/recording-preview.html`, with MIME
   `text/html;profile=mcp-app`; overview tools must reference it and the
   `RecordingPreview` data tool must be private/app-only. Both CSP formats must
   deny arbitrary external resources and connections. Captured data and bundled
   player code stay inside the authenticated host bridge; no remote page iframe
   is embedded. Some assets that cannot be inlined may be absent in the preview.
3. On the existing listing's **MCPs** tab, rescan the deployed server and review
   the new tool, overview UI metadata, OAuth schemes, read-only annotations, HTML,
   and CSP findings. Existing approved definitions can remain active while held
   changes are checked. Deploying alone does not guarantee store availability.
   A server-only update does not require a new package ZIP.
4. For this metadata/skill update, upload the complete ZIP as a new version of
   the existing plugin. Do not create a duplicate listing or try to submit the
   manual Pro ZIP. Confirm category **Developer Tools** against the dashboard's
   choices, listing import, logo, and preserved connection settings. If the
   existing connection uses a provided OAuth client, retain its registration;
   enter any required client secret only in the secure portal. Public discovery
   currently supports DCR and CIMD, PKCE S256, and the three identity scopes.
5. Complete domain verification only if the portal requires it. Use the exact
   portal-issued value at the specified `/.well-known/openai-apps-challenge` URL.
   Do not invent a challenge or overwrite one belonging to a different listing.
   No new challenge was issued as part of this preparation.
6. Resolve required MCP, metadata, and skill-scan findings. Enter reviewer access
   privately; verify the imported cases, walkthrough, and release notes. Rerun
   all cases against the selected draft and record the results.
7. The listing owner can then submit the selected draft for review and complete
   the policy attestations. Only one review may be active per plugin. After
   approval, publish the approved replacement and verify a fresh store install
   renders the preview. Keep the previous approved package available for rollback.

Submission and publication have not been performed by this preparation. The
required remaining evidence is a deployed backend, authenticated end-to-end
checks, verified reviewer setup, a walkthrough, eight executed review cases,
and the dashboard's scans and review outcome.

## Official references

- [Upload, update, scan, and submit](https://developers.openai.com/plugins/deploy/submission)
- [Package structure and MCP OAuth configuration](https://developers.openai.com/plugins/build/plugins)
- [Plugin and MCP review requirements](https://developers.openai.com/plugins/plugin-guidelines)
- [Desktop-only distribution](https://developers.openai.com/plugins/deploy/desktop-only)
