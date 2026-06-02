---
name: "agent-browser-streaming"
description: "Use when exposing an agent-browser live stream from an Obvious sandbox through a hosted WebSocket relay and viewer. Covers stream port pinning, relay setup, same-origin viewer HTML, hosted service registration, and WebSocket gotchas. This skill is instructions-only and does not add plugin hooks, scripts, MCP, or app bindings."
---

# Agent Browser Streaming

Use this skill when a user needs to watch or interact with an `agent-browser` stream from an Obvious sandbox.

This skill is instructions-only. Do not assume this plugin provides scripts, hooks, MCP tools, app bindings, or generated files. Create any relay/viewer files inside the active Obvious workspace only when the task requires them.

## Replay.io Skill Prerequisite

Before streaming, make sure the `replayio` skill in this same `.obvious/skills` bundle has been loaded and applied for the current session. In particular, verify:

- `agent-browser` is the active browser surface.
- `AGENT_BROWSER_STREAM_PORT` is intentionally selected, usually `9223`.
- `AGENT_BROWSER_EXECUTABLE_PATH` points at Replay Chromium if the stream is part of a Replay-recorded run.
- `RECORD_ALL_CONTENT` and `RECORD_REPLAY_VERBOSE` are set when recording matters.

If setup is unknown, load `../replayio/SKILL.md` first, apply it, then return to this skill.

## How Streaming Works

`agent-browser` exposes a WebSocket stream server that sends messages like:

```json
{"type":"frame","data":"<base64-jpeg>"}
```

Key facts:

- Frames are change-triggered. They arrive when the page updates, not at a fixed FPS.
- A burst of frames fires on every new WebSocket connection.
- The stream sends frames only to the most recent upstream WebSocket connection. If two upstream clients connect, the older one stops receiving frames.
- `screencasting: true` in status means the mechanism is armed, not that frames are flowing continuously.
- Frames are sent as binary WebSocket frames. Always convert to string before `JSON.parse`.
- Hosted Obvious proxy URLs support WebSocket upgrades.
- Obvious iframe sandboxing can block WebSocket connections from inside an iframe. Open the viewer URL directly in a new browser tab.

## Step 1 - Pin The Stream Port

The stream port is random unless pinned. If streaming is already enabled, disable it before enabling the desired port:

```bash
agent-browser stream disable
agent-browser stream enable --port 9223
agent-browser stream status --json
```

Expected status shape:

```json
{"enabled":true,"port":9223,"connected":true,"screencasting":true}
```

`AGENT_BROWSER_STREAM_PORT=9223` only affects fresh daemon starts. If a session is already running, use `agent-browser stream disable` and `agent-browser stream enable --port 9223`.

Always use `127.0.0.1`, not `localhost`, for the local WebSocket URL.

## Step 2 - Build The WebSocket Relay

The relay bridges sandbox-local `ws://127.0.0.1:9223` to a public hosted port that viewers can reach through the Obvious hosted proxy.

Critical rule: normalize binary upstream frames to strings before forwarding. The upstream sends binary frames; browser viewers expect text JSON.

Create a workspace-local relay file, for example `/home/user/work/stream-viewer/relay.mjs`:

```js
import { WebSocketServer, WebSocket } from "ws";
import http from "http";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const UPSTREAM_URL = "ws://127.0.0.1:9223";
const PORT = 9100;

const viewers = new Set();
let upstream = null;
let lastFrame = null;
let frameCount = 0;

function connectUpstream() {
  console.log("[relay] connecting upstream");
  const ws = new WebSocket(UPSTREAM_URL);
  upstream = ws;

  ws.on("open", () => {
    console.log("[relay] upstream open");
    ws.send(JSON.stringify({
      type: "startScreencast",
      params: { format: "jpeg", quality: 80 }
    }));
  });

  ws.on("message", (data, isBinary) => {
    const str = isBinary
      ? (Buffer.isBuffer(data) ? data.toString("utf8") : Buffer.from(data).toString("utf8"))
      : data.toString();

    try {
      const msg = JSON.parse(str);
      if (msg.type === "frame") {
        frameCount++;
        lastFrame = str;
        if (frameCount === 1 || frameCount % 30 === 0) {
          console.log(`[relay] frame #${frameCount} to ${viewers.size} viewer(s)`);
        }
      }
    } catch (error) {
      console.error("[relay] parse error:", error.message);
      return;
    }

    for (const viewer of viewers) {
      if (viewer.readyState === WebSocket.OPEN) {
        try {
          viewer.send(str);
        } catch {}
      }
    }
  });

  ws.on("close", (code) => {
    console.log(`[relay] upstream closed (${code}); reconnecting in 2s`);
    upstream = null;
    setTimeout(connectUpstream, 2000);
  });

  ws.on("error", (error) => {
    console.error("[relay] upstream error:", error.message);
  });
}

const server = http.createServer((req, res) => {
  fs.readFile(path.join(__dirname, "index.html"), (error, data) => {
    if (error) {
      res.writeHead(404);
      res.end("not found");
      return;
    }
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(data);
  });
});

const wss = new WebSocketServer({ server });

wss.on("connection", (viewer) => {
  viewers.add(viewer);
  console.log(`[relay] viewer connected (${viewers.size} total)`);

  if (lastFrame) {
    try {
      viewer.send(lastFrame);
    } catch {}
  }

  if (upstream?.readyState === WebSocket.OPEN) {
    upstream.send(JSON.stringify({
      type: "startScreencast",
      params: { format: "jpeg", quality: 80 }
    }));
  }

  viewer.on("message", (data) => {
    if (upstream?.readyState === WebSocket.OPEN) {
      try {
        upstream.send(data.toString());
      } catch {}
    }
  });

  viewer.on("error", () => {});
  viewer.on("close", () => {
    viewers.delete(viewer);
    console.log(`[relay] viewer gone (${viewers.size} remaining)`);
  });
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`[relay] HTTP+WS on port ${PORT}`);
  connectUpstream();
});
```

## Step 3 - Build The Viewer HTML

The viewer should connect to same-origin WebSocket using `location.host`. This works through the hosted proxy.

Create `/home/user/work/stream-viewer/index.html`:

```html
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>Agent Browser Live</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      background: #111;
      display: flex;
      flex-direction: column;
      align-items: center;
      min-height: 100vh;
      font-family: monospace;
      color: #aaa;
      padding: 16px;
    }
    #status { padding: 8px 16px; font-size: 13px; margin-bottom: 8px; }
    #status.connected { color: #4ade80; }
    #status.disconnected { color: #f87171; }
    #info { font-size: 11px; color: #555; margin-bottom: 8px; }
    canvas { border: 1px solid #333; max-width: 100%; cursor: crosshair; }
  </style>
</head>
<body>
  <div id="status" class="disconnected">Connecting...</div>
  <div id="info"></div>
  <canvas id="c"></canvas>
  <script>
    const statusEl = document.getElementById("status");
    const infoEl = document.getElementById("info");
    const canvas = document.getElementById("c");
    const ctx = canvas.getContext("2d");
    let frameCount = 0;

    function connect() {
      const proto = location.protocol === "https:" ? "wss:" : "ws:";
      const ws = new WebSocket(`${proto}//${location.host}`);

      ws.onopen = () => {
        statusEl.textContent = "Connected - waiting for frames";
        statusEl.className = "connected";
      };

      ws.onmessage = (event) => {
        const process = (str) => {
          let msg;
          try {
            msg = JSON.parse(str);
          } catch {
            return;
          }
          if (msg.type !== "frame") return;

          frameCount++;
          infoEl.textContent = `frames: ${frameCount}`;
          statusEl.textContent = "Live";
          statusEl.className = "connected";

          const img = new Image();
          img.onload = () => {
            canvas.width = img.width;
            canvas.height = img.height;
            ctx.drawImage(img, 0, 0);
          };
          img.src = "data:image/jpeg;base64," + msg.data;
        };

        if (event.data instanceof Blob) {
          event.data.text().then(process);
        } else {
          process(event.data);
        }
      };

      ws.onclose = () => {
        statusEl.textContent = "Disconnected - retrying...";
        statusEl.className = "disconnected";
        setTimeout(connect, 1500);
      };

      ws.onerror = () => ws.close();

      canvas.addEventListener("click", (event) => {
        if (ws.readyState !== WebSocket.OPEN) return;
        const rect = canvas.getBoundingClientRect();
        ws.send(JSON.stringify({
          type: "input_mouse",
          x: Math.round((event.clientX - rect.left) * canvas.width / rect.width),
          y: Math.round((event.clientY - rect.top) * canvas.height / rect.height),
          button: "left",
          action: "click"
        }));
      });

      document.addEventListener("keydown", (event) => {
        if (ws.readyState !== WebSocket.OPEN) return;
        ws.send(JSON.stringify({
          type: "input_keyboard",
          key: event.key,
          code: event.code
        }));
      });
    }

    connect();
  </script>
</body>
</html>
```

## Step 4 - Start And Host

Install dependencies and start the relay:

```bash
cd /home/user/work/stream-viewer
npm install ws

tmux kill-session -t svc-9100 2>/dev/null || true
sleep 1
tmux new-session -d -s svc-9100 \
  "node /home/user/work/stream-viewer/relay.mjs 2>&1 | tee /home/user/work/logs/stream-relay.log"

for i in {1..15}; do
  curl -sf http://127.0.0.1:9100/ >/dev/null && echo "UP" && break
  sleep 1
done
```

Register the hosted service so dependencies survive sandbox wakes:

```js
register-hosted-service({
  port: 9100,
  name: "Agent Browser Stream Viewer",
  startupCommand: "node /home/user/work/stream-viewer/relay.mjs",
  workDir: "/home/user/work/stream-viewer",
  install: "cd /home/user/work/stream-viewer && npm install ws"
})
```

Create an iframe artifact with the `hostedUrl`, but tell the user to open the hosted URL in a new browser tab. Do not rely on the Obvious iframe to view the stream.

## Step 5 - View The Stream

Do not use the Obvious iframe artifact to view the stream. The Obvious iframe sandbox can block WebSocket connections from inside it.

Open the hosted URL directly in a new browser tab:

```text
https://<sandbox-id>-9100.hosted.obvious.ai
```

If it says connected but no frames arrive, interact with the agent browser page to trigger repaints.

## Gotchas

| Problem | Cause | Fix |
|---|---|---|
| `[object Blob] is not valid JSON` | Upstream sends binary frames | Use the `isBinary` flag plus `Buffer.toString("utf8")` in the relay; use `Blob.text()` in the viewer |
| Connected and waiting forever | Obvious iframe sandbox blocks WebSocket connections | Open the viewer URL in a real browser tab |
| Only 2 frames then silence | Page is static | Interact with agent-browser by clicking, typing, scrolling, or navigating |
| Upstream drops when relay reconnects | Two upstream WebSocket clients can boot each other | Keep one persistent upstream connection; do not reconnect upstream on every viewer join |
| `stream enable --port` errors with already enabled | Stream must be disabled first | Run `agent-browser stream disable`, then `agent-browser stream enable --port 9223` |
| `localhost` WebSocket fails silently | IPv6 or host resolution mismatch | Always use `127.0.0.1`, never `localhost` |

## Reporting

When reporting streaming setup, include:

- The pinned stream port.
- The relay port and hosted URL.
- Whether `agent-browser stream status --json` reports `enabled`, `connected`, and `screencasting`.
- Whether the hosted URL was opened in a new browser tab.
- Any current blocker, especially missing frames, iframe sandboxing, or upstream reconnect loops.
