# Replay.io Plugins

This repository is a shadcn GitHub registry for Replay.io agent and editor plugin bundles.

Install a bundle with `shadcn add`:

```bash
npx shadcn@latest add replayio/plugins/codex
npx shadcn@latest add replayio/plugins/cursor
npx shadcn@latest add replayio/plugins/claude-code
npx shadcn@latest add replayio/plugins/opencode
npx shadcn@latest add replayio/plugins/obviously
```

## Registry Items

| Item | Installs |
| --- | --- |
| `codex` | Codex plugin bundle with Replay MCP, Replay skill, hooks, scripts, and app metadata. |
| `cursor` | Cursor plugin bundle with Replay MCP, Replay skill, hooks, scripts, and plugin metadata. |
| `claude-code` | Claude Code plugin bundle with Replay MCP, Replay skill, hooks, scripts, and plugin metadata. |
| `opencode` | OpenCode plugin bundle with Replay MCP config, workflow guidance, and OpenCode hooks. |
| `obviously` | Skills-only Obvious bundle installed to `.obvious/skills/...`. |

The Codex, Cursor, Claude Code, and OpenCode items write their generated bundles under matching `dist/...` paths. The Obvious item writes directly to `.obvious/skills/...`.

## Validate

Validate the registry before publishing changes:

```bash
npx shadcn@latest registry validate registry.json
```
