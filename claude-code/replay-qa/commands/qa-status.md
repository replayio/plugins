---
description: Show or watch Replay QA project status
argument-hint: "[--watch]"
allowed-tools: Bash, Read
---

Show Replay QA status for the project id in `.replay/config.json`.

Use the bundled script:

```bash
SCRIPT="${CLAUDE_PLUGIN_ROOT:-.claude/skills/replay-qa}/skills/replay-qa/scripts/status.js"
node "$SCRIPT" $ARGUMENTS
```

If `$ARGUMENTS` includes `--watch`, keep polling until the user asks you to stop or there is a useful state change to report.
