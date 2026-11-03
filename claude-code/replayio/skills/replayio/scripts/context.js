#!/usr/bin/env node
const childProcess = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

function run(command, args) {
  try {
    return {
      ok: true,
      stdout: childProcess.execFileSync(command, args, {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      }).trim(),
    };
  } catch (error) {
    return {
      ok: false,
      status: error.status,
      stderr: String(error.stderr || error.message || error).trim(),
    };
  }
}

function firstLine(text) {
  return String(text || "").split(/\r?\n/)[0] || "";
}

const defaultChromium = path.join(
  os.homedir(),
  ".replay",
  "runtimes",
  "Replay-Chromium.app",
  "Contents",
  "MacOS",
  "Chromium"
);
const executable = process.env.AGENT_BROWSER_EXECUTABLE_PATH || defaultChromium;
const chromeProfile = process.env.AGENT_BROWSER_PROFILE || "Default";

const context = {
  replay_cli: {
    info: run("replayio", ["info"]),
    whoami: run("replayio", ["whoami"]),
  },
  jq: (() => {
    const result = run("jq", ["--version"]);
    return {
      ok: result.ok,
      version: result.ok ? firstLine(result.stdout) : "",
      install: {
        macos: "brew install jq",
        ubuntu_debian: "sudo apt update && sudo apt install jq",
        windows: "winget install jqlang.jq",
        verify: "jq --version",
      },
      error: result.ok ? undefined : result.stderr,
    };
  })(),
  replay_chromium: {
    path: executable,
    exists: fs.existsSync(executable),
    executable: fs.existsSync(executable) ? Boolean(fs.statSync(executable).mode & 0o111) : false,
    export_command: `export AGENT_BROWSER_EXECUTABLE_PATH=${JSON.stringify(executable)}`,
  },
  chrome_profile_import: {
    profile: chromeProfile,
    source: process.env.AGENT_BROWSER_PROFILE ? "environment" : "default",
    export_command: `export AGENT_BROWSER_PROFILE=${JSON.stringify(chromeProfile)}`,
    list_command: "agent-browser profiles",
    behavior: "agent-browser copies a read-only snapshot of this Chrome profile into the Replay Chromium session and deletes the temporary copy when the browser closes",
  },
  recording_environment: {
    RECORD_ALL_CONTENT: process.env.RECORD_ALL_CONTENT || "",
    RECORD_REPLAY_VERBOSE: process.env.RECORD_REPLAY_VERBOSE || "",
    export_commands: [
      "export RECORD_ALL_CONTENT='1'",
      "export RECORD_REPLAY_VERBOSE='1'",
    ],
  },
  rrweb_guidance: {
    recordings_dir: path.join(os.homedir(), ".replay", "rrweb", "recordings"),
    open: "plugin root scripts/browser-open.js <url> [--session name]; any agent-browser command is recorded too",
    close: "plugin root scripts/browser-close.js [--session name]; finishes the .rrweb file and uploads the Replay recordings",
    watch: "plugin root live/rrweb.mjs play [latest|session|id|path]: a viewer URL, streaming live or playing historically",
    upload: "A Replay upload failure does not affect the .rrweb file; report it separately.",
  },
  record_replay_script_guidance: {
    use_when:
      "Local app recording needs a repeatable full-stack run with emulators, app startup, a Replay Playwright config, and upload metadata.",
    upload_rule:
      "Poll replayio list --json and upload only recordings with recordingStatus == finished; never upload IDs that are still recording.",
    jq:
      "Use jq to filter replayio list --json by date, title, URI, recordingStatus, and uploadStatus; install jq first if missing.",
  },
  emulation_guidance: {
    recommend_when: [
      "login/session flow depends on a missing backend",
      "database/API/email/payment/OAuth services are absent in the local run",
      "static prototype has a login form but no logged-in route",
    ],
    required_action: "Elicit whether the user wants as-is local behavior or emulation before recording backend-dependent flows.",
    memory: "Only create a memory note for the chosen mode when the user explicitly asks to remember it.",
  },
};

process.stdout.write(`${JSON.stringify(context, null, 2)}\n`);
