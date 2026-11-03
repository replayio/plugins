---
description: List Replay QA bugs and fetch details for repair work
argument-hint: "[--status open|fixed|wontfix|invalid] [--details] [--save]"
allowed-tools: Bash, Read, Edit, Write, MultiEdit, Grep, Glob
---

List Replay QA bugs for this project and use the results to drive code repair.

```bash
npx --yes replayqa@0.6.0 bugs --details --save $ARGUMENTS
```

Read the full bug details before making code changes. They are saved under `.replay/qa-bugs/`. After a bug is fixed, mark it fixed so Replay QA automatically retries the affected journey:

```bash
npx --yes replayqa@0.6.0 mark-bug <bug-id> fixed
```
