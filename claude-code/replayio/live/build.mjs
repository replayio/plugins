// Builds the two browser assets the live players need, from npm:
//   tracer.js   @replayio-app-building/session-recorder, bundled as an
//               init script that drains captured packets to the
//               __replayClaudeEmit binding the relay's inject script adds.
//   vendor/     rrweb's UMD build and stylesheet, for player.html's Replayer
//               (the same rrweb version the recorder records with).
import path from 'node:path'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import * as esbuild from 'esbuild'

const here = path.dirname(fileURLToPath(import.meta.url))

const entry = `
import { startSession } from "@replayio-app-building/session-recorder";

(function replayClaudeTracer() {
  if (window.top !== window || window.__replayClaudeTracer) return;
  const emit = window.__replayClaudeEmit;
  if (typeof emit !== "function") return;
  window.__replayClaudeTracer = true;

  // The recorder assumes a secure context with real storage. A file:// page or a plain-http
  // LAN address has neither crypto.randomUUID nor usable localStorage, and without these
  // it throws while starting and records nothing.
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID !== "function") {
    Object.defineProperty(crypto, "randomUUID", {
      configurable: true,
      writable: true,
      value: () => {
        const b = crypto.getRandomValues(new Uint8Array(16));
        b[6] = (b[6] & 15) | 64;
        b[8] = (b[8] & 63) | 128;
        const h = Array.from(b, x => x.toString(16).padStart(2, "0")).join("");
        return h.slice(0, 8) + "-" + h.slice(8, 12) + "-" + h.slice(12, 16) + "-" + h.slice(16, 20) + "-" + h.slice(20);
      },
    });
  }
  for (const name of ["localStorage", "sessionStorage"]) {
    try {
      void window[name].length;
    } catch {
      const data = new Map();
      const memory = {
        get length() { return data.size; },
        key: i => [...data.keys()][i] ?? null,
        getItem: k => (data.has(String(k)) ? data.get(String(k)) : null),
        setItem: (k, v) => { data.set(String(k), String(v)); },
        removeItem: k => { data.delete(String(k)); },
        clear: () => data.clear(),
      };
      Object.defineProperty(window, name, { configurable: true, get: () => memory });
    }
  }

  // Installs the capture proxies (fetch, WebSocket, storage) and rrweb, which
  // waits for DOMContentLoaded itself, so this runs at document start.
  let session;
  try {
    session = startSession();
  } catch (err) {
    emit(JSON.stringify([{ kind: "detectedError", time: new Date().toISOString(), detectedError: { message: "Replay live tracer failed to start: " + String(err && err.message || err) } }]));
    return;
  }

  const flush = () => {
    const packets = session.getSessionData();
    if (packets.length === 0) return;
    emit(JSON.stringify(packets));
    session.release?.(packets.length);
  };
  setInterval(flush, 200);
  window.addEventListener("pagehide", flush);
})();
`

await esbuild.build({
  stdin: { contents: entry, resolveDir: here, sourcefile: 'tracer-entry.js' },
  bundle: true,
  outfile: path.join(here, 'tracer.js'),
  format: 'iife',
  platform: 'browser',
  target: 'es2020',
  minify: true,
  legalComments: 'none',
  define: { 'process.env.NODE_ENV': '"production"' },
  logLevel: 'warning',
})

// rrweb's exports map hides package.json, so read it off node_modules.
const rrwebDir = path.join(here, 'node_modules', 'rrweb')
const rrwebDist = path.join(rrwebDir, 'dist')
fs.mkdirSync(path.join(here, 'vendor'), { recursive: true })
const umd = ['rrweb.umd.min.cjs', 'rrweb.umd.cjs', 'rrweb.min.js'].find(f => fs.existsSync(path.join(rrwebDist, f)))
const css = ['style.min.css', 'style.css', 'rrweb.min.css'].find(f => fs.existsSync(path.join(rrwebDist, f)))
if (!umd || !css) throw new Error(`rrweb dist has no UMD build or stylesheet: ${fs.readdirSync(rrwebDist).join(', ')}`)
fs.copyFileSync(path.join(rrwebDist, umd), path.join(here, 'vendor', 'rrweb.min.js'))
fs.copyFileSync(path.join(rrwebDist, css), path.join(here, 'vendor', 'rrweb.min.css'))
console.log(`Built tracer.js and vendor/ (rrweb ${JSON.parse(fs.readFileSync(path.join(rrwebDir, 'package.json'), 'utf8')).version}: ${umd}, ${css})`)
