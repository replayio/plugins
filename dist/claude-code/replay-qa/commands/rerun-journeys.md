---
description: Retry supported Replay QA journey workflows
argument-hint: "[--bug-id id | --journey-id id | missing-bug-description]"
allowed-tools: Bash, Read, Edit, Write, MultiEdit, Grep, Glob
---

Use Replay QA's supported journey retry alternatives. The current OpenAPI spec does not expose a direct "run this single journey now" endpoint.

Use the bundled script:

```bash
SCRIPT="${CLAUDE_PLUGIN_ROOT:-.claude/skills/replay-qa}/skills/replay-qa/scripts/rerun-journeys.js"
node "$SCRIPT" $ARGUMENTS
```

Supported flows:

- `--bug-id <id>` marks a fixed bug as `fixed`, which automatically retries the affected journey.
- `--journey-id <id>` lists prior test runs for that journey.
- Positional text reports a missing bug, which creates an investigation journey.
