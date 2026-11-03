---
description: Show or watch Replay QA project status
argument-hint: "[--watch]"
allowed-tools: Bash, Read
---

Show Replay QA status for the project id in `.replay/config.json`.

```bash
npx --yes replayqa@0.7.0 status $ARGUMENTS
```

If `$ARGUMENTS` includes `--watch`, keep polling until the user asks you to stop or there is a useful state change to report.
