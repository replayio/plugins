---
description: Record a Replay Chromium browser session (with an MP4 only if asked)
argument-hint: "[url] [proof instructions]"
allowed-tools: Bash, Read, Edit, Write, MultiEdit, Grep, Glob
---

Use Replay.io Pro to record browser evidence for this project.

1. Load the `replayio` skill from `${CLAUDE_PLUGIN_ROOT:-.claude/skills/replayio}/skills/replayio`.
2. Resolve `SCRIPT_DIR="${CLAUDE_PLUGIN_ROOT:-.claude/skills/replayio}/scripts"`.
3. Start the app, open the requested URL with `browser-open.js`, interact through the returned Playwright session, and close with `browser-close.js`. Pass `--output <file>.mp4` to both only if the user asked for a video.
4. Report any uploaded Replay recording URLs, and the verified MP4 path if one was made. If upload reports you are not signed in, follow the skill's "Signing In To Replay" steps: start `replayio login` in the background, then stop and wait for the user.

Use `$ARGUMENTS` as the URL and proof instructions.
