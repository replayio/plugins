# Playwright CLI Workflows

Use the wrapper script and snapshot often. Assume `PWCLI` is set.

## Standard interaction loop

```bash
"$PWCLI" open https://example.com
"$PWCLI" snapshot
"$PWCLI" click e3
"$PWCLI" snapshot
"$PWCLI" close
```

## Debugging and inspection

Capture console messages and network activity after reproducing an issue:

```bash
mkdir -p output/playwright/debug
"$PWCLI" snapshot
"$PWCLI" console error
"$PWCLI" console warning
"$PWCLI" network
"$PWCLI" screenshot output/playwright/debug/repro.png
```

For live browser state, use direct CLI commands first:

```bash
"$PWCLI" eval "location.href"
"$PWCLI" eval "document.title"
"$PWCLI" localstorage-list
"$PWCLI" sessionstorage-list
"$PWCLI" cookie-list
```

Use Replay analysis tools only after the recording has uploaded and direct CLI output is not enough to explain the issue.
