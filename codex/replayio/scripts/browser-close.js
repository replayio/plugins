#!/usr/bin/env node
const childProcess = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

function parseArgs(argv) {
  const args = { _: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith("--")) {
      args._.push(arg);
      continue;
    }
    const key = arg.slice(2).replace(/-([a-z])/g, (_, char) => char.toUpperCase());
    const next = argv[index + 1];
    if (next && !next.startsWith("--")) {
      args[key] = next;
      index += 1;
    } else {
      args[key] = true;
    }
  }
  return args;
}

function run(command, args, options = {}) {
  try {
    return {
      ok: true,
      stdout: childProcess.execFileSync(command, args, {
        encoding: "utf8",
        stdio: options.inherit ? "inherit" : ["ignore", "pipe", "pipe"],
        timeout: options.timeoutMs,
      }),
    };
  } catch (error) {
    return {
      ok: false,
      status: error.status,
      stderr: String(error.stderr || error.message || error).trim(),
    };
  }
}

function runPlaywright(args) {
  return run("npx", ["--yes", "--package", "@playwright/cli", "playwright-cli", ...args], {
    inherit: true,
  });
}

function readState(statePath) {
  try {
    return JSON.parse(fs.readFileSync(statePath, "utf8"));
  } catch {
    return {};
  }
}

function getMime(filePath) {
  const result = run("file", ["-b", "--mime-type", filePath]);
  return result.ok ? result.stdout.trim() : "";
}

function ffmpegInstallInstructions() {
  return [
    "ffmpeg is required to create MP4 recordings.",
    "",
    "Install it, then rerun:",
    "",
    "macOS:",
    "  brew install ffmpeg",
    "",
    "Ubuntu/Debian:",
    "  sudo apt update && sudo apt install ffmpeg",
    "",
    "Windows:",
    "  winget install Gyan.FFmpeg",
    "  # or: choco install ffmpeg",
    "",
    "After install, verify:",
    "  ffmpeg -version",
  ].join("\n");
}

function requireFfmpeg() {
  const result = run("ffmpeg", ["-version"]);
  if (!result.ok) {
    throw new Error(ffmpegInstallInstructions());
  }
}

function runFfmpeg(args) {
  const result = run("ffmpeg", args);
  if (!result.ok) {
    throw new Error(`ffmpeg failed while creating MP4 output:\n${result.stderr}`);
  }
}

function transcodeWebmToMp4(sourcePath, outputPath) {
  requireFfmpeg();
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  const samePath = path.resolve(sourcePath) === path.resolve(outputPath);
  const targetPath = samePath
    ? path.join(path.dirname(outputPath), `${path.basename(outputPath, path.extname(outputPath))}.transcoded-${Date.now()}.mp4`)
    : outputPath;

  runFfmpeg([
    "-y",
    "-i",
    sourcePath,
    "-c:v",
    "libx264",
    "-crf",
    "23",
    "-preset",
    "veryfast",
    "-pix_fmt",
    "yuv420p",
    "-movflags",
    "+faststart",
    targetPath,
  ]);

  if (samePath) {
    fs.unlinkSync(outputPath);
    fs.renameSync(targetPath, outputPath);
  }
}

function uploadRecordings(sessionStartedAt) {
  const uploadAll = process.env.REPLAYIO_UPLOAD_ALL === "1" ? run("replayio", ["upload-all"], { timeoutMs: 180000 }) : undefined;
  if (uploadAll?.ok) {
    return { command: "upload-all", result: uploadAll };
  }
  const list = run("replayio", ["list", "--json"]);
  if (list.ok) {
    const jsonStart = list.stdout.indexOf("[");
    const payload = jsonStart >= 0 ? list.stdout.slice(jsonStart) : list.stdout;
    try {
      const recordings = JSON.parse(payload);
      const startedMs = Date.parse(sessionStartedAt || "");
      const minimumDateMs = Number.isFinite(startedMs) ? startedMs - 60_000 : Date.now() - 10 * 60_000;
      const ids = recordings
        .filter((recording) => recording.recordingStatus === "finished" && recording.uploadStatus !== "uploaded")
        .filter((recording) => {
          const recordingDateMs = Date.parse(recording.date || "");
          return Number.isFinite(recordingDateMs) && recordingDateMs >= minimumDateMs;
        })
        .map((recording) => recording.id);
      if (ids.length === 0) {
        return { command: "upload", result: { ok: true, stdout: "No pending recordings." } };
      }
      return { command: "upload", result: run("replayio", ["upload", ...ids], { timeoutMs: 180000 }) };
    } catch (error) {
      return { command: "upload", result: { ok: false, status: 1, stderr: String(error.message || error) } };
    }
  }
  return { command: "upload", result: run("replayio", ["upload"], { timeoutMs: 180000 }) };
}

const args = parseArgs(process.argv.slice(2));
const statePath = path.join(process.cwd(), ".replay", "browser-session.json");
const state = readState(statePath);
const outputInput = args.output || args.videoPath || args._[0] || state.mp4_path || state.video_path || "";
const output = outputInput ? path.resolve(outputInput) : "";
const webmInput = args.webmPath || state.webm_path || "";
const webmPath = webmInput ? path.resolve(webmInput) : "";
const response = { video: undefined, upload: undefined };

if (output && path.extname(output).toLowerCase() === ".mp4") {
  const stopResult = runPlaywright(["video-stop"]);
  response.video_stop = stopResult.ok ? "ok" : stopResult.stderr;
}

runPlaywright(["close"]);

if (output) {
  const sourcePath = webmPath || output;
  if (!fs.existsSync(sourcePath)) {
    throw new Error(`Expected WebM capture file was not created: ${sourcePath}`);
  }
  const sourceStats = fs.statSync(sourcePath);
  if (sourceStats.size <= 0) {
    throw new Error(`WebM capture file is empty: ${sourcePath}`);
  }
  const sourceMime = getMime(sourcePath);
  if (/webm/i.test(sourceMime) || path.extname(sourcePath).toLowerCase() === ".webm") {
    transcodeWebmToMp4(sourcePath, output);
  } else if (sourcePath !== output) {
    throw new Error(`Expected WebM capture input, got ${sourceMime || "unknown MIME"} at ${sourcePath}`);
  }

  if (!fs.existsSync(output)) {
    throw new Error(`Expected MP4 file was not created: ${output}`);
  }
  const stats = fs.statSync(output);
  if (stats.size <= 0) {
    throw new Error(`MP4 file is empty: ${output}`);
  }
  const mime = getMime(output);
  if (!/mp4|quicktime/i.test(mime)) {
    throw new Error(`The output is ${mime || "unknown MIME"}, not MP4. Do not embed it as an MP4.`);
  }
  response.video = {
    output,
    bytes: stats.size,
    mime: mime || undefined,
    source: sourcePath,
    source_mime: sourceMime || undefined,
    encoder: "ffmpeg",
  };
}

response.upload = uploadRecordings(state.started_at);
try {
  fs.unlinkSync(statePath);
} catch {}

process.stdout.write(`${JSON.stringify(response, null, 2)}\n`);

if (response.upload?.result && !response.upload.result.ok) {
  process.exit(response.upload.result.status || 1);
}
