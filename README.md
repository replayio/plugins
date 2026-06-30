# Replay.io Plugins

This repository is a shadcn GitHub registry for Replay.io agent and editor plugin bundles.

Install a bundle with `shadcn add`:

```bash
npx shadcn@latest add replayio/plugins/codex
npx shadcn@latest add replayio/plugins/cursor
npx shadcn@latest add replayio/plugins/claude-code
npx shadcn@latest add replayio/plugins/opencode
npx shadcn@latest add replayio/plugins/obvious-ai
```

Install the Codex bundle as a Codex plugin marketplace:

```bash
codex plugin marketplace add https://github.com/replayio/agent-harness-plugins --ref main
codex plugin add replayio@replayio-plugins
```

If you use sparse checkout when adding the marketplace, include both the marketplace manifest and
the plugin bundle path:

```bash
codex plugin marketplace add https://github.com/replayio/agent-harness-plugins \
  --ref main \
  --sparse .agents/plugins/marketplace.json \
  --sparse dist/codex/replayio
```

## Registry Items

| Item | Installs |
| --- | --- |
| `codex` | Codex plugin bundle installed to `.codex-plugin/`, `skills/replayio/`, `skills/replay-qa-api/`, `assets/`, and metadata files. |
| `cursor` | Cursor plugin bundle installed to `.cursor-plugin/`, `skills/`, `assets/`, hooks, scripts, and MCP config. |
| `claude-code` | Claude Code Replay QA plugin installed to `.claude/skills/replay-qa/`, including plugin commands and script-backed skill helpers. |
| `opencode` | OpenCode plugin bundle installed to `.opencode/plugins/`, `AGENTS.md`, and `opencode.json`. |
| `obvious-ai` | Skills-only Obvious bundle installed to `.obvious/skills/replay-qa-api/SKILL.md`, including direct Replay QA API, Replay CLI token fallback, artifact, and project-reuse guidance. |

The registry reads generated source files from `dist/...`, but each item installs into the platform-specific destination paths that plugin hosts expect.

## Validate

Validate the registry before publishing changes:

```bash
npx shadcn@latest registry validate registry.json
```
