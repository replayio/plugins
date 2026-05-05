# Playwright CLI Reference

Set up the wrapper:

```bash
export RECORD_ALL_CONTENT='1'
export RECORD_REPLAY_VERBOSE='1'
export PWCLI="${CLAUDE_PLUGIN_ROOT:-$PWD/dist/claude-code/replayio}/skills/replayio/scripts/playwright_cli.sh"
```

The Replay plugin ships this wrapper so `playwright-cli` can run without a global install. If the plugin root variable is unavailable, run from the generated plugin root or point `PWCLI` at the Replay plugin checkout.

## Basics

```bash
"$PWCLI" open https://example.com --headed
"$PWCLI" snapshot
"$PWCLI" click e3
"$PWCLI" screenshot output/playwright/repro/page.png
"$PWCLI" close
```

## Sessions

Use explicit sessions to isolate work:

```bash
"$PWCLI" --session marketing open https://example.com
"$PWCLI" --session marketing snapshot
"$PWCLI" --session marketing close
```

Keep session names short on macOS.

## Inspection

Use direct CLI inspection before reaching for Replay analysis tools:

- `console [level]` reads captured browser console messages.
- `network` shows captured fetch/XHR activity.
- `screenshot [path]` captures the page or element visually.
- `eval <expression>` or `eval "el => ..." e5` reads page state.
- `localstorage-list`, `sessionstorage-list`, and `cookie-list` inspect browser state.
