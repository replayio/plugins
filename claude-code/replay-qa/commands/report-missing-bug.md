---
description: Ask Replay QA to investigate a bug it did not report
argument-hint: "[description]"
allowed-tools: Bash, Read
---

Report a missing bug to Replay QA. This creates an investigation journey, and a bug should appear later if Replay QA confirms the issue.

```bash
npx --yes replayqa@0.6.0 report-missing-bug $ARGUMENTS
```

Then poll status and bugs:

```bash
npx --yes replayqa@0.6.0 status
npx --yes replayqa@0.6.0 bugs --status open --details
```
