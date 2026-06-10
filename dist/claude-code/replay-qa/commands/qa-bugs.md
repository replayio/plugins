---
description: List Replay QA bugs and fetch details for repair work
argument-hint: "[--status open|fixed|wontfix|invalid] [--details] [--save]"
allowed-tools: Bash, Read, Edit, Write, MultiEdit, Grep, Glob
---

List Replay QA bugs for this project and use the results to drive code repair.

Use the bundled script:

```bash
SCRIPT="${CLAUDE_PLUGIN_ROOT:-.claude/skills/replay-qa}/skills/replay-qa/scripts/bugs.js"
node "$SCRIPT" --details --save $ARGUMENTS
```

Read the full bug details before making code changes. After a bug is fixed, mark it fixed so Replay QA automatically retries the affected journey:

```bash
SCRIPT="${CLAUDE_PLUGIN_ROOT:-.claude/skills/replay-qa}/skills/replay-qa/scripts/mark-bug.js"
node "$SCRIPT" <bug-id> fixed
```
