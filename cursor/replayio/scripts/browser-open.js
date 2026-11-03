#!/usr/bin/env node
// Opens a URL in Replay Chromium with agent-browser and records it to a .rrweb file.
// Usage: browser-open.js <url> [--session name]. Prints the session, the file and a viewer URL.
const { spawnSync } = require("node:child_process");
const path = require("node:path");

const cli = path.join(__dirname, "..", "live", "rrweb.mjs");
const { status } = spawnSync(process.execPath, [cli, "open", ...process.argv.slice(2)], { stdio: "inherit" });
process.exit(status ?? 1);
