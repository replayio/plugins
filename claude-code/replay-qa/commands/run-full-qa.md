---
description: Bootstrap or resume Replay QA and review current open bugs
argument-hint: "[target-url] [instructions]"
allowed-tools: Bash, Read, Edit, Write, MultiEdit, Grep, Glob
---

Run the Replay QA full workflow for this project.

```bash
npx --yes replayqa@0.7.0 full-qa $ARGUMENTS
```

If it creates a local reverse-proxy project and prints a runbook, run the runbook in a background shell from the project root so Replay QA can reach the local app. If the script returns open bugs, read the full bug details, fix the code, then mark each fixed bug with:

```bash
npx --yes replayqa@0.7.0 mark-bug <bug-id> fixed
```

After marking fixes, poll status and list open bugs again until Replay QA reports no open bugs.
