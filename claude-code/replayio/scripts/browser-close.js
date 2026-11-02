#!/usr/bin/env node
// Closes an agent-browser session, finishes its .rrweb file and uploads its Replay recording.
// Usage: browser-close.js [--session name]. Prints the file, a viewer URL and the Replay URLs.
const { spawnSync } = require("node:child_process");
const path = require("node:path");

const cli = path.join(__dirname, "..", "live", "rrweb.mjs");
const { status } = spawnSync(process.execPath, [cli, "close", ...process.argv.slice(2)], { stdio: "inherit" });
process.exit(status ?? 1);
