---
description: Start a focused Replay QA exploration on an existing project
argument-hint: "[prompt]"
allowed-tools: Bash, Read
---

Start a new Replay QA exploration only because the user asked for one.

Use the bundled script:

```bash
SCRIPT="${CLAUDE_PLUGIN_ROOT:-.claude/skills/replay-qa}/skills/replay-qa/scripts/start-exploration.js"
node "$SCRIPT" $ARGUMENTS
```

After starting the exploration, poll status with:

```bash
SCRIPT="${CLAUDE_PLUGIN_ROOT:-.claude/skills/replay-qa}/skills/replay-qa/scripts/status.js"
node "$SCRIPT" --watch
```
