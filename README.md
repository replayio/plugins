# Replay.io Plugins

This repository is a shadcn GitHub registry for Replay.io agent and editor plugin bundles.

Install a bundle with `shadcn add`:

```bash
npx shadcn@latest add replayio/plugins/codex
npx shadcn@latest add replayio/plugins/codex-pro
npx shadcn@latest add replayio/plugins/cursor
npx shadcn@latest add replayio/plugins/claude-code
npx shadcn@latest add replayio/plugins/claude-pro
npx shadcn@latest add replayio/plugins/opencode
npx shadcn@latest add replayio/plugins/obvious-ai
```

`codex` and `claude-code` are Replay QA for production, staging, and PR preview QA runs. `codex-pro` and `claude-pro` are direct Replay.io dev tools bundles with Replay MCP, Replay Chromium, worker/critic proof-loop prompts, browser lifecycle screencast capture, ffmpeg-backed MP4 output, side-by-side video stitching, upload hooks, and MP4 video embedding.

Install the Codex bundles as a Codex plugin marketplace:

```bash
codex plugin marketplace add https://github.com/replayio/plugins --ref main
codex plugin add replay-qa@replayio-plugins
codex plugin add replayio@replayio-plugins
```

If you use sparse checkout when adding the marketplace, include both the marketplace manifest and
the plugin bundle path:

```bash
codex plugin marketplace add https://github.com/replayio/plugins \
  --ref main \
  --sparse .agents/plugins/marketplace.json \
  --sparse codex/replay-qa \
  --sparse codex/replayio
```

## Registry Items

| Item | Installs |
| --- | --- |
| `codex` | Codex Replay QA app installed to `.codex-plugin/`, `skills/replay-qa/`, `assets/`, and packaged scripts for project setup, status, bugs, journeys, test runs, explorations, and fix verification. |
| `codex-pro` | Codex Replay.io Pro dev tools installed to `.codex-plugin/`, `.mcp.json`, `.app.json`, `agents/openai.yaml`, `hooks.json`, `scripts/`, `skills/replayio/`, and `assets/`, with worker/critic proof-loop prompts, browser-open/browser-close lifecycle scripts, a side-by-side stitch helper, and hooks for screencast capture, ffmpeg-backed MP4 output, and Replay uploads. |
| `cursor` | Cursor plugin bundle installed to `.cursor-plugin/`, `skills/`, `assets/`, hooks, scripts, MCP config, and worker/critic proof-loop prompts. |
| `claude-code` | Claude Code Replay QA plugin installed to `.claude/skills/replay-qa/`, including plugin commands and script-backed skill helpers. |
| `claude-pro` | Claude Code Replay.io Pro plugin installed to `.claude/skills/replayio/`, `.claude/agents/`, hooks, scripts, MCP config, commands, and Replay Pro skill guidance. |
| `opencode` | OpenCode plugin bundle installed to `.opencode/plugins/`, `.opencode/agent/`, `AGENTS.md`, and `opencode.json`, including worker/critic proof-loop subagents. |
| `obvious-ai` | Skills-only Obvious bundle installed to `.obvious/skills/replay-qa-api/SKILL.md`, including direct Replay QA API, Replay CLI token fallback, artifact, and project-reuse guidance. |

The registry reads generated source files from the top-level platform directories, but each item installs into the platform-specific destination paths that plugin hosts expect.

## Validate

Validate the registry before publishing changes:

```bash
npx shadcn@latest registry validate registry.json
```
