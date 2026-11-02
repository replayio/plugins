import { fileURLToPath } from "node:url";

// Every agent-browser session runs in Replay Chromium and is recorded as an rrweb stream by the
// shared relay: see ../replayio-live/rrweb.mjs.
const cli = fileURLToPath(new URL("../replayio-live/rrweb.mjs", import.meta.url));

function shellText(value) {
  if (!value) return "";
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.join(" ");
  if (typeof value === "object") {
    return (
      value.command ||
      value.cmd ||
      value.shell ||
      value.args?.command ||
      value.args?.cmd ||
      ""
    );
  }
  return "";
}

async function log(client, level, message) {
  try {
    await client?.app?.log?.({
      body: {
        service: "replayio-opencode",
        level,
        message,
      },
    });
  } catch {
    // Logging should never affect the agent loop.
  }
}

function formatError(error) {
  return error instanceof Error ? error.message : String(error);
}

export const ReplayPlugin = async ({ client, $, directory }) => {
  const replayChromium =
    (process.env.HOME || "") + "/.replay/runtimes/Replay-Chromium.app/Contents/MacOS/Chromium";

  await log(client, "info", "Replay.io OpenCode plugin initialized");

  return {
    "shell.env": async (_input, output) => {
      output.env ??= {};
      output.env.RECORD_ALL_CONTENT ??= "1";
      output.env.RECORD_REPLAY_VERBOSE ??= "1";
      output.env.AGENT_BROWSER_EXECUTABLE_PATH ??= replayChromium;
    },

    "tool.execute.after": async (input) => {
      if (input?.tool !== "bash" && input?.tool !== "shell") return;
      const command = shellText(input?.args || input?.tool_input || input);
      if (!/agent-browser/.test(command)) return;
      const event = JSON.stringify({ command, cwd: directory });
      try {
        await $`echo ${event} | node ${cli} hook`.quiet();
      } catch (error) {
        await log(client, "warn", `Replay rrweb recorder: ${formatError(error)}`);
      }
    },

    event: async ({ event }) => {
      if (event.type !== "session.idle") return;
      try {
        await $`node ${cli} stop`.quiet().cwd(directory);
        await log(client, "info", "Closed this directory's Replay browsers and uploaded their recordings");
      } catch (error) {
        await log(client, "warn", `Replay rrweb recorder: ${formatError(error)}`);
      }
    },
  };
};
