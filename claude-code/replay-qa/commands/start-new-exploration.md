---
description: Start a focused Replay QA exploration on an existing project
argument-hint: "[prompt]"
allowed-tools: Bash, Read
---

Start a new Replay QA exploration only because the user asked for one.

Use the bundled script:

```bash
SCRIPT="${CLAUDE_PLUGIN_ROOT:-.claude/skills/replayqa}/skills/replayqa/scripts/start-exploration.js"
node "$SCRIPT" $ARGUMENTS
```

With function hooks enabled the result of that command is a live player of the exploration; tell the user they can run `/replayqa canvas` to watch every journey at once.

After starting the exploration, poll status with:

```bash
SCRIPT="${CLAUDE_PLUGIN_ROOT:-.claude/skills/replayqa}/skills/replayqa/scripts/status.js"
node "$SCRIPT" --watch
```
