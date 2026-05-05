const closePattern = /(playwright|pwcli|PWCLI).*close/;

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

async function commandExists($, command) {
  try {
    await $`command -v ${command} >/dev/null 2>&1`;
    return true;
  } catch {
    return false;
  }
}

async function uploadPending($, client) {
  if (!(await commandExists($, "replayio"))) {
    await log(client, "warn", "replayio CLI not found on PATH; skipping upload");
    return;
  }
  try {
    await $`replayio upload-all >/dev/null 2>&1 || replayio upload >/dev/null 2>&1 || true`;
    await log(client, "info", "Uploaded pending Replay recordings");
  } catch (error) {
    await log(client, "warn", `Replay upload failed: ${formatError(error)}`);
  }
}

async function closeLingeringSessions($, client) {
  if (!(await commandExists($, "npx"))) return;
  let listing = "";
  try {
    const result = await $`npx --yes --package @playwright/cli playwright-cli list 2>/dev/null || true`;
    listing = String(result.stdout || "");
  } catch {
    return;
  }

  const sessions = new Set();
  for (const line of listing.split(/\r?\n/)) {
    const match = line.match(/^\s+([A-Za-z0-9_-]+)\b/);
    if (match) sessions.add(match[1]);
  }

  for (const session of sessions) {
    try {
      await $`npx --yes --package @playwright/cli playwright-cli --session=${session} close >/dev/null 2>&1 || true`;
      await log(client, "info", `Closed lingering Replay browser session: ${session}`);
    } catch {
      // Best effort cleanup only.
    }
  }
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

export const ReplayPlugin = async ({ client, $ }) => {
  const pluginRoot = new URL("..", import.meta.url);
  const pwcli = new URL("replayio/scripts/playwright_cli.sh", pluginRoot).pathname;

  await log(client, "info", "Replay.io OpenCode plugin initialized");

  return {
    "shell.env": async (_input, output) => {
      output.env ??= {};
      output.env.RECORD_ALL_CONTENT ??= "1";
      output.env.RECORD_REPLAY_VERBOSE ??= "1";
      output.env.PWCLI ??= pwcli;
    },

    "tool.execute.after": async (input) => {
      const text = shellText(input?.args || input?.tool_input || input);
      if (input?.tool === "bash" || input?.tool === "shell") {
        if (closePattern.test(text)) {
          await uploadPending($, client);
        }
      }
    },

    event: async ({ event }) => {
      if (event.type === "session.idle") {
        await closeLingeringSessions($, client);
        await uploadPending($, client);
      }
    },
  };
};
