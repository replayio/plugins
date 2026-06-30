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

const context = {
  replay_cli: {
    info: run("replayio", ["info"]),
    whoami: run("replayio", ["whoami"]),
  },
  ffmpeg: (() => {
    const result = run("ffmpeg", ["-version"]);
    return {
      ok: result.ok,
      version: result.ok ? firstLine(result.stdout) : "",
      install: {
        macos: "brew install ffmpeg",
        ubuntu_debian: "sudo apt update && sudo apt install ffmpeg",
        windows: "winget install Gyan.FFmpeg # or: choco install ffmpeg",
        verify: "ffmpeg -version",
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
  recording_environment: {
    RECORD_ALL_CONTENT: process.env.RECORD_ALL_CONTENT || "",
    RECORD_REPLAY_VERBOSE: process.env.RECORD_REPLAY_VERBOSE || "",
    export_commands: [
      "export RECORD_ALL_CONTENT='1'",
      "export RECORD_REPLAY_VERBOSE='1'",
    ],
  },
  mp4_guidance: {
    use: "plugin root scripts/browser-open.js and scripts/browser-close.js with a .mp4 output path; browser-close.js waits for video-stop and ffmpeg before returning",
    internal_capture: "Playwright screencast/video capture writes WebM first, then ffmpeg transcodes it to verified MP4",
    avoid: "Playwright BrowserContext recordVideo, native Chromium video artifacts, or renaming WebM files to .mp4",
  },
};

process.stdout.write(`${JSON.stringify(context, null, 2)}\n`);
