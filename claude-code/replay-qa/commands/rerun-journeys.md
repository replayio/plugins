---
description: Retry supported Replay QA journey workflows
argument-hint: "[--bug-id id | --journey-id id | missing-bug-description]"
allowed-tools: Bash, Read, Edit, Write, MultiEdit, Grep, Glob
---

Use Replay QA's supported journey retry alternatives. The current OpenAPI spec does not expose a direct "run this single journey now" endpoint.

```bash
npx --yes replayqa@0.6.0 rerun-journeys $ARGUMENTS
```

Supported flows:

- `--bug-id <id>` marks a fixed bug as `fixed`, which automatically retries the affected journey.
- `--journey-id <id>` lists prior test runs for that journey.
- Positional text reports a missing bug, which creates an investigation journey.
