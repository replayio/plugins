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

## Registry Items

| Item | Installs |
| --- | --- |
| `codex` | Codex plugin bundle installed to `.codex-plugin/`, `skills/replayio/`, `skills/loop-qa-api/`, `assets/`, hooks, scripts, and metadata files. |
| `cursor` | Cursor plugin bundle installed to `.cursor-plugin/`, `skills/`, `assets/`, hooks, scripts, and MCP config. |
| `claude-code` | Claude Code project plugin installed to `.claude/skills/replayio/`. |
| `opencode` | OpenCode plugin bundle installed to `.opencode/plugins/`, `AGENTS.md`, and `opencode.json`. |
| `obvious-ai` | Skills-only Obvious bundle installed to `.obvious/skills/...`. |

The registry reads generated source files from `dist/...`, but each item installs into the platform-specific destination paths that plugin hosts expect.

## Validate

Validate the registry before publishing changes:

```bash
npx shadcn@latest registry validate registry.json
```
