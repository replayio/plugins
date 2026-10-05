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

  // Installs the capture proxies (fetch, WebSocket, storage) and rrweb, which
  // waits for DOMContentLoaded itself, so this runs at document start.
  const session = startSession();

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
