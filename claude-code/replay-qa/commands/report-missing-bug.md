---
description: Ask Replay QA to investigate a bug it did not report
argument-hint: "[description]"
allowed-tools: Bash, Read
---

Report a missing bug to Replay QA. This creates an investigation journey, and a bug should appear later if Replay QA confirms the issue.

Use the bundled script:

```bash
SCRIPT="${CLAUDE_PLUGIN_ROOT:-.claude/skills/replay-qa}/skills/replay-qa/scripts/report-missing-bug.js"
node "$SCRIPT" $ARGUMENTS
```

Then poll status and bugs:

```bash
SCRIPT_DIR="${CLAUDE_PLUGIN_ROOT:-.claude/skills/replay-qa}/skills/replay-qa/scripts"
node "$SCRIPT_DIR/status.js"
node "$SCRIPT_DIR/bugs.js" --status open --details
```
