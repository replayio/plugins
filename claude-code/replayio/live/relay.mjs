#!/usr/bin/env node
// The rrweb relay every Replay plugin shares: one daemon per machine, started by rrweb.mjs.
//
// - Joins each agent-browser session over CDP and injects the rrweb recorder (tracer.js) into
//   every document, so page CSP never blocks it.
// - Appends the stream to <dir>/recordings/<stamp>-<session>-<id>.rrweb as it arrives.
// - Serves player.html, which plays a recording with rrweb's Replayer, either live (SSE) or
//   from the start, and any .rrweb already on disk.
// - Renders players in a headless Chrome and screencasts them to PNG files a host can draw
//   inline (the Claude Code mod's <Image>). GET /frames long-polls for new frames.
//
// .rrweb files hold one JSON value per line. A line whose `type` is a number is an rrweb event,
// verbatim; one whose `type` is a string is the relay's own (header, feed, replay_id, replay, end).
//
// Zero dependencies: Node >= 22 (global fetch + WebSocket).

import http from 'node:http'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'
import { execFile, spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

/** live/: this script, the player pages, tracer.js and vendor/. */
const HERE = path.dirname(fileURLToPath(import.meta.url))
const DATA_DIR = process.env.REPLAY_RRWEB_DIR || path.join(os.homedir(), '.replay', 'rrweb')
const REC_DIR = path.join(DATA_DIR, 'recordings')
const FRAME_DIR = path.join(DATA_DIR, 'frames')
/** Where this daemon says it is listening: `{ pid, port, token, version, dataDir }`. */
const RELAY_FILE = path.join(DATA_DIR, 'relay.json')
/** Bumped when a running daemon must make way for a newer plugin's. */
const RELAY_VERSION = 2
const TOKEN = crypto.randomUUID()
const PLAYER_W = 1280
const PLAYER_H = 800
const MAX_FPS = 12
const LONG_POLL_MS = 20_000

for (const dir of [REC_DIR, FRAME_DIR]) fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
// Recordings hold what the pages showed: only this user reads them.
fs.chmodSync(DATA_DIR, 0o700)
fs.chmodSync(REC_DIR, 0o700)
migrateLegacy()

const log = (...args) => process.stderr.write(`[replayio rrweb relay] ${args.join(' ')}\n`)
const safeId = id => String(id).replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 120)
const stampOf = ms => new Date(ms || Date.now()).toISOString().replace(/[:]/g, '-').replace(/\..+$/, '')

/** Moves what an earlier version kept under ~/.claude/replayio-live: the line format is still read. */
function migrateLegacy() {
  if (process.env.REPLAY_RRWEB_DIR) return
  const legacy = path.join(os.homedir(), '.claude', 'replayio-live')
  const move = (from, to) => { try { fs.renameSync(from, to) } catch {} }
  for (const [dir, into, rename] of [['recordings', REC_DIR, n => n.replace(/\.ndjson$/, '.rrweb')], ['frames', FRAME_DIR, n => n]]) {
    let names = []
    try { names = fs.readdirSync(path.join(legacy, dir)) } catch {}
    for (const name of names) move(path.join(legacy, dir, name), path.join(into, rename(name)))
  }
}

// ---------------------------------------------------------------- recordings

/** @type {Map<string, Recording>} */
const recordings = new Map()
/** session name -> recording id currently receiving events */
const bySession = new Map()

/**
 * @typedef {{ id: string, session: string, source: string, status: 'live'|'ended',
 *   url: string|null, startedAt: number, endedAt: number|null, events: any[],
 *   feed: any[], activePage: number|null, clients: Set<http.ServerResponse>,
 *   meta: { width: number, height: number }|null, file: string }} Recording
 */

function newRecording(id, session, source, cwd = process.cwd()) {
  const startedAt = Date.now()
  const file = path.join(REC_DIR, `${stampOf(startedAt)}-${safeId(session)}-${safeId(id)}.rrweb`)
  const rec = {
    id, session, source, cwd, status: 'live', url: null, startedAt, endedAt: null,
    events: [], feed: [], activePage: null, clients: new Set(), meta: null, file,
    out: fs.createWriteStream(file, { flags: 'a', mode: 0o600 }),
  }
  rec.out.on('error', err => log('append failed', err.message))
  recordings.set(id, rec)
  appendLine(rec, { type: 'header', id, session, source, cwd, startedAt })
  return rec
}

function appendLine(rec, obj) {
  if (rec.out) rec.out.write(JSON.stringify(obj) + '\n')
  else fs.appendFile(rec.file, JSON.stringify(obj) + '\n', err => err && log('append failed', err.message))
}

/** The file holding recording `id`: `<stamp>-<session>-<id>.rrweb`, or `<id>.rrweb` from before. */
function fileOf(id) {
  const safe = safeId(id)
  const name = fs.readdirSync(REC_DIR).find(n => n === `${safe}.rrweb` || n.endsWith(`-${safe}.rrweb`))
  return name ? path.join(REC_DIR, name) : null
}

function parseRecording(rec, text) {
  // Someone else's rrweb export: a plain JSON array of events.
  if (text.trimStart().startsWith('[')) {
    applyEvents(rec, JSON.parse(text), false)
    return
  }
  for (const line of text.split('\n')) {
    if (!line) continue
    try {
      const obj = JSON.parse(line)
      if (typeof obj.type === 'number') applyEvents(rec, [obj], false)
      else if (obj.type === 'header') Object.assign(rec, { session: obj.session, source: obj.source, startedAt: obj.startedAt, cwd: obj.cwd })
      else if (obj.type === 'events') applyEvents(rec, obj.events, false)
      else if (obj.type === 'feed') rec.feed.push(...obj.items)
      else if (obj.type === 'end') rec.endedAt = obj.endedAt
      else if (obj.type === 'replay') rec.replay = obj.recordings
      else if (obj.type === 'replay_id') (rec.replayIds ??= new Set()).add(obj.id)
      else if (obj.type === 'reset') rec.events = []
    } catch {}
  }
}

function loadRecording(id, file = fileOf(id)) {
  const existing = recordings.get(id)
  if (existing) return existing
  if (!file || !fs.existsSync(file)) return null
  const rec = {
    id, session: id, source: 'disk', status: 'ended', url: null, startedAt: 0, endedAt: null,
    events: [], feed: [], activePage: null, clients: new Set(), meta: null, file,
  }
  parseRecording(rec, fs.readFileSync(file, 'utf8'))
  if (!rec.startedAt) rec.startedAt = rec.events[0]?.timestamp ?? fs.statSync(file).mtimeMs
  recordings.set(id, rec)
  return rec
}

function applyEvents(rec, events, persist) {
  for (const ev of events) {
    rec.events.push(ev)
    if (ev.type === 4 && ev.data) {
      rec.meta = { width: ev.data.width, height: ev.data.height }
      if (ev.data.href) rec.url = ev.data.href
    }
  }
  if (persist) for (const ev of events) appendLine(rec, ev)
}

function broadcast(rec, event, data) {
  const chunk = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
  for (const res of rec.clients) res.write(chunk)
}

function summarizeFeed(packet) {
  switch (packet.kind) {
    case 'detectedError': return { kind: 'error', text: packet.detectedError?.message ?? 'error', time: packet.time }
    case 'locationHref': return { kind: 'nav', text: packet.href, time: packet.time }
    case 'serverURL': return { kind: 'nav', text: packet.url, time: packet.time }
    default: return null
  }
}

/** Packets from one page of one session, as the tracer emitted them. */
function ingest(session, page, pageUrl, packets) {
  const id = bySession.get(session)
  const rec = id && recordings.get(id)
  if (!rec || rec.status !== 'live') return false
  // Every page's, not just the one the player follows: all of them are this session's recordings.
  for (const packet of packets) {
    if (packet.kind !== 'replayRecording' || rec.replayIds?.has(packet.id)) continue
    ;(rec.replayIds ??= new Set()).add(packet.id)
    appendLine(rec, { type: 'replay_id', id: packet.id })
  }
  // A new document (the tracer's first packet is `version`) makes its page the
  // one the player follows, so a navigation or a newly opened tab takes over.
  const isNewDocument = packets.some(p => p.kind === 'version')
  if (isNewDocument && rec.activePage !== page) {
    rec.activePage = page
  }
  if (rec.activePage === null) rec.activePage = page
  if (page !== rec.activePage) return true
  if (pageUrl) rec.url = pageUrl
  const events = []
  const feed = []
  for (const packet of packets) {
    if (packet.kind === 'rrweb' && packet.event) events.push(packet.event)
    else {
      const item = summarizeFeed(packet)
      if (item) feed.push(item)
    }
  }
  if (events.length) {
    applyEvents(rec, events, true)
    broadcast(rec, 'events', { from: rec.events.length - events.length, events })
  }
  if (feed.length) {
    rec.feed.push(...feed)
    if (rec.feed.length > 500) rec.feed.splice(0, rec.feed.length - 500)
    appendLine(rec, { type: 'feed', items: feed })
    broadcast(rec, 'feed', feed)
  }
  bump(rec.id)
  return true
}

function endRecording(rec) {
  if (rec.status === 'ended') return
  rec.status = 'ended'
  rec.endedAt = Date.now()
  if (bySession.get(rec.session) === rec.id) bySession.delete(rec.session)
  detachCdp(rec.session)
  appendLine(rec, { type: 'end', endedAt: rec.endedAt })
  rec.out?.end()
  rec.out = null
  broadcast(rec, 'status', { status: 'ended' })
  bump(rec.id)
  // Park an inline player on the finished recording's last moment.
  const live = players.get(rec.id)
  if (live?.mode === 'live') setTimeout(() => { if (players.get(rec.id) === live) void control(rec.id, 'seek', durationOf(rec.events)).catch(() => {}) }, 1500)
  // Replay Chromium finishes writing its recording as the browser closes.
  setTimeout(() => void linkReplay(rec).catch(err => log('replay link failed', err.message)), 3000)
}

// ------------------------------------------------------- replay recordings

/** Runs the replayio CLI and resolves its stdout (stderr folded into a rejection). */
function replayio(args, timeout = 120_000) {
  return new Promise((resolve, reject) => {
    execFile('replayio', args, { timeout, maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(new Error((stderr || stdout || err.message).replace(/\x1b\[[0-9;]*m/g, '').trim().slice(-400)))
      else resolve(stdout)
    })
  })
}

/**
 * The Replay Chromium recordings of a browser session: exactly the ones its pages reported being
 * part of. Never matched by host or time, as an upload must not take another session's recording.
 * A session in another browser has none.
 */
async function linkReplay(rec) {
  if (!rec.replayIds?.size) return []
  const out = await replayio(['list', '--json'], 30_000)
  const list = JSON.parse(out.slice(out.indexOf('[')))
  const found = list
    .filter(r => rec.replayIds.has(r.id))
    .map(r => ({
      id: r.id,
      uri: r.metadata?.uri ?? null,
      date: r.date,
      durationMs: r.duration ?? null,
      recordingStatus: r.recordingStatus ?? null,
      uploadStatus: r.uploadStatus ?? null,
      url: `https://app.replay.io/recording/${r.id}`,
    }))
  rec.replay = found
  appendLine(rec, { type: 'replay', recordings: found })
  const f = frames.get(rec.id)
  if (f) f.seq = (f.seq ?? 0) + 1
  bump(rec.id)
  return found
}

const UPLOAD_WAIT_S = 20
let login = null

/** Starts `replayio login` (an interactive browser sign-in) once; it finishes on its own. */
function startLogin() {
  if (login && login.exitCode === null) return
  login = spawn('replayio', ['login'], { stdio: 'ignore', detached: true })
  login.on('error', err => log('replayio login failed', err.message))
  login.unref()
}

/** Uploads a session's Replay recordings that are not uploaded yet. */
async function uploadReplay(rec, { login: signIn = true } = {}) {
  let linked = await linkReplay(rec)
  // Replay Chromium finishes writing a recording after the browser closes, and an unfinished one can't upload.
  for (let i = 0; i < UPLOAD_WAIT_S && linked.some(r => r.recordingStatus === 'recording'); i++) {
    await new Promise(resolve => setTimeout(resolve, 1000))
    linked = await linkReplay(rec)
  }
  const pending = linked.filter(r => r.uploadStatus !== 'uploaded' && r.recordingStatus !== 'recording').map(r => r.id)
  if (pending.length === 0 && linked.length === 0) throw new Error('no Replay recording was made for this session (was it Replay Chromium with RECORD_ALL_CONTENT=1?)')
  if (pending.length) {
    // `replayio upload` signed out starts an interactive browser sign-in and
    // waits on it; a button press must fail fast instead.
    const who = await replayio(['whoami'], 30_000).catch(err => err.message)
    if (!process.env.REPLAY_API_KEY && /not authenticated|log in/i.test(who)) {
      if (signIn) startLogin()
      const err = new Error(signIn
        ? 'Sign in to Replay in the browser tab that just opened, then press Upload again.'
        : 'Not signed in to Replay: the recording stays local until `replayio login`.')
      err.needsLogin = true
      throw err
    }
    await replayio(['upload', ...pending], 10 * 60_000)
  }
  return linkReplay(rec)
}

function durationOf(events) {
  return events.length > 1 ? events[events.length - 1].timestamp - events[0].timestamp + 1 : 0
}

function describe(rec) {
  return {
    id: rec.id, session: rec.session, status: rec.status, url: rec.url,
    startedAt: rec.startedAt, endedAt: rec.endedAt, eventCount: rec.events.length,
    durationMs: durationOf(rec.events), cwd: rec.cwd ?? null, file: rec.file, replay: rec.replay ?? [],
    meta: rec.meta, lastError: [...rec.feed].reverse().find(f => f.kind === 'error')?.text ?? null,
  }
}

const summaries = new Map()

/** A recording on disk, described without keeping its events; cached until the file changes. */
function summarize(file, fallbackId) {
  const { mtimeMs } = fs.statSync(file)
  const cached = summaries.get(file)
  if (cached?.mtimeMs === mtimeMs) return cached.summary
  const rec = { id: fallbackId, session: fallbackId, status: 'ended', url: null, startedAt: 0, endedAt: null,
    events: [], feed: [], meta: null, file, clients: new Set() }
  const text = fs.readFileSync(file, 'utf8')
  try { parseRecording(rec, text) } catch {}
  if (!rec.startedAt) rec.startedAt = rec.events[0]?.timestamp ?? mtimeMs
  try { const head = JSON.parse(text.split('\n', 1)[0]); if (head?.type === 'header') rec.id = head.id } catch {}
  const summary = describe(rec)
  summaries.set(file, { mtimeMs, summary })
  return summary
}

/** Every recording on disk, newest first. */
function listAll() {
  const out = []
  for (const name of fs.readdirSync(REC_DIR)) {
    if (!name.endsWith('.rrweb')) continue
    const summary = summarize(path.join(REC_DIR, name), name.slice(0, -'.rrweb'.length))
    const loaded = recordings.get(summary.id)
    out.push(loaded ? describe(loaded) : summary)
  }
  return out.sort((a, b) => b.startedAt - a.startedAt)
}

/**
 * What a person or an agent names a recording by: `latest`, a session, an id, a file name, or
 * the path of any .rrweb file (someone else's rrweb export included).
 */
function resolveRef(ref) {
  const wanted = String(ref || 'latest').trim()
  if (wanted.includes('/') || /\.rrweb(\.json)?$|\.json$/.test(wanted)) {
    const full = path.resolve(wanted.startsWith('~/') ? path.join(os.homedir(), wanted.slice(2)) : wanted)
    if (fs.existsSync(full)) {
      const known = listAll().find(r => r.file === full)
      if (known) return loadRecording(known.id)
      return loadRecording(`file-${crypto.createHash('sha1').update(full).digest('hex').slice(0, 12)}`, full)
    }
  }
  const all = listAll()
  const found = wanted === 'latest'
    ? all.find(r => r.status === 'live') ?? all[0]
    : all.find(r => r.id === wanted || path.basename(r.file) === wanted || path.basename(r.file, '.rrweb') === wanted)
      ?? all.find(r => r.session === wanted)
  return found ? loadRecording(found.id, found.file) : null
}

// ------------------------------------------------------------------- tracer

const TRACER = path.join(HERE, 'tracer.js')

/** The script injected into every page: session-recorder's capture, built by `npm run build`. */
function tracerSource() {
  if (!fs.existsSync(TRACER)) throw new Error(`missing ${TRACER}: run npm install && npm run build in ${HERE}`)
  return fs.readFileSync(TRACER, 'utf8')
}

// ------------------------------------------------------- headless renderer

let version = 0
/** recording id -> { file, generation, width, height, mode, status } */
const frames = new Map()
const waiters = new Set()

function bump(id) {
  version += 1
  if (id) {
    const f = frames.get(id)
    if (f) f.version = version
  }
  for (const wake of waiters) wake()
  waiters.clear()
}

function findChrome() {
  // Replay Chromium first: the plugin already installs it, and with
  // RECORD_ALL_CONTENT unset (start() clears it) it records nothing.
  const replayChromium = process.platform === 'darwin'
    ? path.join(os.homedir(), '.replay', 'runtimes', 'Replay-Chromium.app', 'Contents', 'MacOS', 'Chromium')
    : path.join(os.homedir(), '.replay', 'runtimes', 'chrome-linux', 'chrome')
  const candidates = [
    process.env.REPLAY_LIVE_CHROME,
    replayChromium,
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
  ].filter(Boolean)
  for (const c of candidates) if (fs.existsSync(c)) return c
  const cache = path.join(os.homedir(), process.platform === 'darwin' ? 'Library/Caches/ms-playwright' : '.cache/ms-playwright')
  try {
    const dirs = fs.readdirSync(cache).filter(d => d.startsWith('chromium-')).sort().reverse()
    for (const d of dirs) {
      for (const rel of [
        'chrome-mac/Chromium.app/Contents/MacOS/Chromium',
        'chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
        'chrome-mac-x64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
        'chrome-linux/chrome',
        'chrome-linux64/chrome',
      ]) {
        const p = path.join(cache, d, rel)
        if (fs.existsSync(p)) return p
      }
    }
  } catch {}
  return null
}

class Chrome {
  constructor() {
    this.nextId = 1
    this.pending = new Map()
    this.handlers = new Map() // sessionId -> fn(method, params)
    this.ready = null
  }

  start() {
    if (this.ready) return this.ready
    this.ready = new Promise((resolve, reject) => {
      const bin = findChrome()
      if (!bin) return reject(new Error('No browser found for the inline player: install Replay Chromium (npx @replayio/replay install) or set REPLAY_LIVE_CHROME'))
      const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'replayio-live-chrome-'))
      const env = { ...process.env }
      delete env.RECORD_ALL_CONTENT
      delete env.RECORD_REPLAY_VERBOSE
      this.proc = spawn(bin, [
        '--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`,
        '--no-first-run', '--no-default-browser-check', '--hide-scrollbars', '--mute-audio',
        '--disable-background-timer-throttling', '--disable-renderer-backgrounding',
        '--disable-backgrounding-occluded-windows', 'about:blank',
      ], { stdio: ['ignore', 'ignore', 'pipe'], env })
      let err = ''
      this.proc.stderr.on('data', chunk => {
        err += chunk
        const m = /DevTools listening on (ws:\/\/\S+)/.exec(err)
        if (m && !this.connecting) {
          this.connecting = true
          this.connect(m[1]).then(resolve, reject)
        }
      })
      this.proc.on('exit', code => {
        this.ready = null
        this.connecting = false
        this.ws = null
        for (const { reject: fail } of this.pending.values()) fail(new Error('headless Chrome exited'))
        this.pending.clear()
        reject(new Error(`headless Chrome exited (${code}): ${err.slice(-400)}`))
      })
    })
    return this.ready
  }

  connect(url) {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url)
      ws.onopen = () => { this.ws = ws; resolve() }
      ws.onerror = e => reject(new Error(`CDP connect failed: ${e.message ?? e}`))
      ws.onmessage = msg => {
        const data = JSON.parse(String(msg.data))
        if (data.id && this.pending.has(data.id)) {
          const { resolve, reject } = this.pending.get(data.id)
          this.pending.delete(data.id)
          data.error ? reject(new Error(data.error.message)) : resolve(data.result)
        } else if (data.method) {
          this.handlers.get(data.sessionId)?.(data.method, data.params)
        }
      }
    })
  }

  send(method, params = {}, sessionId) {
    const id = this.nextId++
    this.ws.send(JSON.stringify({ id, method, params, sessionId }))
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }))
  }

  /** `send` for a fresh target, which refuses commands until its first page commits. */
  async sendSettled(method, params, sessionId) {
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.send(method, params, sessionId)
      } catch (err) {
        if (attempt >= 20 || !/not attached/i.test(err.message)) throw new Error(`${method}: ${err.message}`)
        await new Promise(resolve => setTimeout(resolve, 100))
      }
    }
  }

  stop() {
    try { this.proc?.kill() } catch {}
  }
}

const chrome = new Chrome()

// ------------------------------------------------------- browsers we did not launch

/** session -> the relay's own CDP connection to a browser someone else (agent-browser) started. */
const attachments = new Map()

function detachCdp(session) {
  const held = attachments.get(session)
  if (!held) return
  attachments.delete(session)
  try { held.ws?.close() } catch {}
}

/**
 * Injects the tracer into every page of a running browser over its own CDP
 * connection (`wsUrl`, the browser endpoint): a binding for the packets, the
 * tracer as a new-document script for later navigations and tabs, and the
 * tracer evaluated in what is already loaded. CSP cannot block any of it.
 */
async function attachCdp(session, wsUrl) {
  detachCdp(session)
  const cdp = new Chrome()
  await cdp.connect(wsUrl)
  attachments.set(session, cdp)
  // However the browser went away (a close, a crash, a hook), its recording is over.
  cdp.ws.addEventListener('close', () => {
    if (attachments.get(session) !== cdp) return
    attachments.delete(session)
    const rec = recordings.get(bySession.get(session))
    if (rec) endRecording(rec)
  })
  const source = tracerSource()
  const known = new Set()
  let pages = 0
  const attachPage = async info => {
    if (known.has(info.targetId) || info.type !== 'page' || /^(devtools|chrome-extension|chrome-untrusted):/.test(info.url ?? '')) return
    known.add(info.targetId)
    const { sessionId } = await cdp.send('Target.attachToTarget', { targetId: info.targetId, flatten: true })
    const page = ++pages
    cdp.handlers.set(sessionId, (method, params) => {
      if (method !== 'Runtime.bindingCalled' || params.name !== '__replayClaudeEmit') return
      try { ingest(session, page, null, JSON.parse(params.payload)) } catch {}
    })
    await cdp.send('Runtime.enable', {}, sessionId)
    await cdp.send('Runtime.addBinding', { name: '__replayClaudeEmit' }, sessionId)
    await cdp.send('Page.enable', {}, sessionId)
    await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source }, sessionId)
    await cdp.send('Runtime.evaluate', { expression: source }, sessionId).catch(() => {})
  }
  // Browser-level events carry no sessionId; Chrome's handler map keys them under undefined.
  cdp.handlers.set(undefined, (method, params) => {
    if (method === 'Target.targetCreated') attachPage(params.targetInfo).catch(err => log('cdp attach failed', err.message))
    else if (method === 'Target.targetDestroyed') known.delete(params.targetId)
  })
  // Reports every existing target as created, then each new one.
  await cdp.send('Target.setDiscoverTargets', { discover: true })
  // Wait for the first page to be attached, so the caller knows injection happened.
  for (let i = 0; i < 50 && pages === 0; i++) await new Promise(r => setTimeout(r, 100))
  if (pages === 0) throw new Error('no page to attach to in that browser')
}
/** recording id -> { targetId, sessionId, mode, touched, ... } */
const players = new Map()
const MAX_PLAYERS = 4
const IDLE_PLAYER_MS = 10 * 60_000

/** A renderer tab sized to `width` x `height`, its `__playerEvent` binding delivered to `onEvent`. */
async function openTarget(url, width, height, onEvent) {
  await chrome.start()
  const { targetId } = await chrome.send('Target.createTarget', { url: 'about:blank' })
  const { sessionId } = await chrome.send('Target.attachToTarget', { targetId, flatten: true })
  chrome.handlers.set(sessionId, onEvent)
  await chrome.sendSettled('Page.enable', {}, sessionId)
  await chrome.sendSettled('Runtime.enable', {}, sessionId)
  await chrome.sendSettled('Runtime.addBinding', { name: '__playerEvent' }, sessionId)
  await chrome.sendSettled('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false }, sessionId)
  await chrome.sendSettled('Page.navigate', { url }, sessionId)
  return { targetId, sessionId }
}

async function closeTarget(target) {
  chrome.handlers.delete(target.sessionId)
  await chrome.send('Target.closeTarget', { targetId: target.targetId }).catch(() => {})
}

async function evaluate(sessionId, expression) {
  const { result, exceptionDetails } = await chrome.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, sessionId)
  if (exceptionDetails) throw new Error(exceptionDetails.exception?.description ?? exceptionDetails.text)
  return result.value
}

async function waitReady(sessionId) {
  for (let i = 0; i < 150; i++) {
    if (await evaluate(sessionId, 'Boolean(window.__ready)').catch(() => false)) return
    await new Promise(r => setTimeout(r, 100))
  }
  throw new Error('player page did not become ready')
}

/**
 * Starts the screencast player for a recording: `live` follows the stream,
 * `replay` plays (or, `paused`, parks at `t`) the saved recording.
 */
async function startPlayer(id, mode, { t = 0, paused = false } = {}) {
  await stopPlayer(id)
  const rec = loadRecording(id)
  if (!rec) throw new Error(`no recording ${id}`)
  if (players.size >= MAX_PLAYERS) {
    const [oldest] = [...players.entries()].sort((a, b) => a[1].touched - b[1].touched)
    if (oldest) await stopPlayer(oldest[0])
  }
  const port = server.address().port
  const url = `http://127.0.0.1:${port}/player/${encodeURIComponent(id)}?mode=${mode}&t=${Math.round(t)}&paused=${paused ? 1 : 0}&token=${TOKEN}&chrome=0`
  const { width, height } = playerSize(rec)
  const frameFile = path.join(FRAME_DIR, `${safeId(id)}.png`)
  const entry = frames.get(id) ?? { file: frameFile, generation: 0, seq: 0 }
  frames.set(id, {
    ...entry, width, height, mode, status: mode === 'live' ? 'playing' : paused ? 'paused' : 'playing',
    currentMs: t, totalMs: durationOf(rec.events), at: Date.now(), seq: (entry.seq ?? 0) + 1,
  })
  const player = { mode, touched: Date.now(), lastWrite: 0, timer: null, pendingFrame: null }
  players.set(id, player)

  const writeFrame = async data => {
    player.lastWrite = Date.now()
    const tmp = `${frameFile}.${process.pid}.tmp`
    await fsp.writeFile(tmp, Buffer.from(data, 'base64'))
    await fsp.rename(tmp, frameFile)
    const f = frames.get(id)
    if (f) f.generation += 1
    bump(id)
  }

  const target = await openTarget(url, width, height, (method, params) => {
    if (method === 'Page.screencastFrame') {
      chrome.send('Page.screencastFrameAck', { sessionId: params.sessionId }, player.sessionId).catch(() => {})
      // Throttle to MAX_FPS, always keeping the newest frame.
      player.pendingFrame = params.data
      const wait = Math.max(0, 1000 / MAX_FPS - (Date.now() - player.lastWrite))
      if (!player.timer) {
        player.timer = setTimeout(() => {
          player.timer = null
          const data = player.pendingFrame
          player.pendingFrame = null
          if (data) writeFrame(data).catch(err => log('frame write failed', err.message))
        }, wait)
      }
    } else if (method === 'Runtime.bindingCalled' && params.name === '__playerEvent') {
      const f = frames.get(id)
      if (!f || players.get(id) !== player) return
      if (params.payload === 'finished') {
        Object.assign(f, { status: 'finished', currentMs: f.totalMs, at: Date.now() })
        bump(id)
        return
      }
      let s
      try { s = JSON.parse(params.payload) } catch { return }
      const expected = f.status === 'playing' ? f.currentMs + (Date.now() - f.at) : f.currentMs
      const status = s.finished ? 'finished' : s.paused ? 'paused' : 'playing'
      // Report a change of state or a jump; steady playback the client interpolates.
      const changed = status !== f.status || s.total !== f.totalMs || Math.abs(s.t - expected) > 1500
      Object.assign(f, { status, currentMs: s.t, totalMs: s.total, at: Date.now() })
      if (status === 'playing') player.touched = Date.now()
      if (changed) bump(id)
    }
  })
  Object.assign(player, target)
  await chrome.sendSettled('Page.startScreencast', { format: 'png', everyNthFrame: 1, maxWidth: width, maxHeight: height }, target.sessionId)
  bump(id)
}

/** The recorded page's aspect, at most PLAYER_W x PLAYER_H. */
function playerSize(rec) {
  const w = rec.meta?.width || PLAYER_W
  const h = rec.meta?.height || PLAYER_H
  const scale = Math.min(1, PLAYER_W / w, PLAYER_H / h)
  return { width: Math.round(w * scale), height: Math.round(h * scale) }
}

/** Stops the player for `id`; with `only`, just when that one is still current. */
async function stopPlayer(id, only) {
  const player = players.get(id)
  if (!player || (only && player !== only)) return
  players.delete(id)
  clearTimeout(player.timer)
  if (player.sessionId) await closeTarget(player)
  const f = frames.get(id)
  if (f && (f.status === 'playing' || f.status === 'paused')) f.status = 'stopped'
  bump(id)
}

const CONTROLS = {
  play: () => '__ctl.play()',
  pause: () => '__ctl.pause()',
  toggle: () => '__ctl.toggle()',
  seek: ms => `__ctl.seek(${Number(ms) || 0})`,
  seekBy: ms => `__ctl.seekBy(${Number(ms) || 0})`,
}

/** Drives a recording's replay player, starting one (parked where asked) when none runs. */
async function control(id, action, ms) {
  const rec = loadRecording(id)
  if (!rec) throw new Error(`no recording ${id}`)
  const player = players.get(id)
  const f = frames.get(id)
  if (!player || player.mode === 'live' || !player.sessionId) {
    const here = f?.currentMs ?? 0
    const t = action === 'seek' ? Number(ms) || 0 : action === 'seekBy' ? here + (Number(ms) || 0) : f?.status === 'finished' ? 0 : here
    const total = durationOf(rec.events)
    const paused = action === 'pause' || action === 'seek' || action === 'seekBy'
    return startPlayer(id, 'replay', { t: Math.max(0, Math.min(total, t)), paused })
  }
  player.touched = Date.now()
  await evaluate(player.sessionId, CONTROLS[action](ms))
  const s = await evaluate(player.sessionId, '__ctl.state()')
  if (f && s) Object.assign(f, { status: s.finished ? 'finished' : s.paused ? 'paused' : 'playing', currentMs: s.t, totalMs: s.total, at: Date.now(), seq: (f.seq ?? 0) + 1 })
  bump(id)
}

setInterval(() => {
  for (const [id, player] of players) {
    if (player.mode !== 'live' && Date.now() - player.touched > IDLE_PLAYER_MS) void stopPlayer(id, player)
  }
}, 60_000).unref()

function framesSnapshot() {
  const out = {}
  for (const [id, f] of frames) {
    const rec = recordings.get(id)
    out[id] = { ...f, recording: rec ? describe(rec) : null }
  }
  return { version, frames: out }
}

// --------------------------------------------------------------------- http

function send(res, status, body, type = 'application/json') {
  res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' })
  res.end(type === 'application/json' ? JSON.stringify(body) : body)
}

async function readJson(req) {
  let body = ''
  for await (const chunk of req) body += chunk
  return body ? JSON.parse(body) : {}
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://127.0.0.1')
    const parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent)

    if (parts[0] === 'vendor' && /^[a-z0-9.-]+$/.test(parts[1] ?? '')) {
      const file = path.join(HERE, 'vendor', parts[1])
      if (!fs.existsSync(file)) return send(res, 404, { error: 'not found' })
      return send(res, 200, fs.readFileSync(file), parts[1].endsWith('.css') ? 'text/css' : 'text/javascript')
    }

    const token = url.searchParams.get('token') ?? req.headers['x-replay-live-token']
    if (token !== TOKEN) return send(res, 403, { error: 'bad token' })
    touched = Date.now()

    if (req.method === 'GET' && parts[0] === 'health') return send(res, 200, { version: RELAY_VERSION, live: bySession.size })

    // POST /shutdown { ifIdle? } -> make way for a newer daemon
    if (req.method === 'POST' && parts[0] === 'shutdown') {
      const { ifIdle } = await readJson(req)
      if (ifIdle && bySession.size > 0) return send(res, 409, { error: 'recordings are live' })
      send(res, 200, { stopping: true })
      return setTimeout(shutdown, 50)
    }

    // GET /resolve?ref=latest|session|id|path -> the recording it names
    if (req.method === 'GET' && parts[0] === 'resolve') {
      const rec = resolveRef(url.searchParams.get('ref'))
      return rec ? send(res, 200, { ...describe(rec), viewerUrl: viewerUrl(rec.id) }) : send(res, 404, { error: `no recording matches ${url.searchParams.get('ref') ?? 'latest'}` })
    }

    // POST /recordings { id, session, cdp, cwd? } -> record a browser; a session already recorded keeps its recording
    if (req.method === 'POST' && parts[0] === 'recordings' && parts.length === 1) {
      const { id, session, source = 'agent-browser', cwd, cdp } = await readJson(req)
      if (!id || !session || !cdp) return send(res, 400, { error: 'id, session and cdp required' })
      const held = recordings.get(bySession.get(session))
      if (held && attachments.has(session)) return send(res, 200, { recording: describe(held), viewerUrl: viewerUrl(held.id) })
      if (held) endRecording(held)
      const rec = newRecording(id, session, source, cwd || undefined)
      bySession.set(session, id)
      try {
        await attachCdp(session, cdp)
      } catch (err) {
        endRecording(rec)
        return send(res, 502, { error: `could not attach to the browser: ${err.message}` })
      }
      return send(res, 200, { recording: describe(rec), viewerUrl: viewerUrl(id) })
    }

    // POST /sessions/:session/end
    if (req.method === 'POST' && parts[0] === 'sessions' && parts[2] === 'end') {
      const id = bySession.get(parts[1])
      const rec = id && recordings.get(id)
      if (rec) endRecording(rec)
      return send(res, 200, { ended: rec ? rec.id : null })
    }

    // GET /recordings[?all=1] -> this relay's recordings, or every one on disk
    if (req.method === 'GET' && parts[0] === 'recordings' && parts.length === 1) {
      return send(res, 200, url.searchParams.get('all') ? listAll() : [...recordings.values()].map(describe))
    }

    if (parts[0] === 'recordings' && parts[1]) {
      const rec = loadRecording(parts[1])
      if (!rec) return send(res, 404, { error: 'no such recording' })

      if (req.method === 'GET' && parts[2] === undefined) return send(res, 200, describe(rec))
      if (req.method === 'GET' && parts[2] === 'events') return send(res, 200, { recording: describe(rec), events: rec.events, feed: rec.feed })
      if (req.method === 'GET' && parts[2] === 'rrweb.json') {
        // A plain rrweb event array, for rrweb-player or any other Replayer.
        res.writeHead(200, { 'content-type': 'application/json', 'content-disposition': `attachment; filename="${stampOf(rec.startedAt)}-${safeId(rec.session)}.rrweb.json"` })
        return res.end(JSON.stringify(rec.events))
      }

      if (req.method === 'GET' && parts[2] === 'stream') {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' })
        res.write(`event: status\ndata: ${JSON.stringify({ status: rec.status })}\n\n`)
        rec.clients.add(res)
        const ping = setInterval(() => res.write(': ping\n\n'), 15_000)
        req.on('close', () => { clearInterval(ping); rec.clients.delete(res) })
        return
      }

      // POST /recordings/:id/player { mode: 'live' | 'replay' | 'stop' | play | pause | toggle | seek | seekBy, ms? }
      if (req.method === 'POST' && parts[2] === 'player') {
        const { mode, ms } = await readJson(req)
        if (mode === 'stop') await stopPlayer(rec.id)
        else if (mode === 'live' && rec.status === 'live') await startPlayer(rec.id, 'live')
        else if (mode === 'replay' || mode === 'live') await startPlayer(rec.id, 'replay')
        else if (CONTROLS[mode]) await control(rec.id, mode, ms)
        else return send(res, 400, { error: `unknown player mode ${mode}` })
        return send(res, 200, framesSnapshot().frames[rec.id] ?? null)
      }

      // GET /recordings/:id/replay -> re-match its Replay recordings; POST .../replay/upload uploads them
      if (req.method === 'GET' && parts[2] === 'replay') return send(res, 200, await linkReplay(rec))
      if (req.method === 'POST' && parts[2] === 'replay' && parts[3] === 'upload') return send(res, 200, await uploadReplay(rec, await readJson(req)))
    }

    // GET /player/:id -> the page the headless renderer (or a person) loads
    if (req.method === 'GET' && parts[0] === 'player' && parts[1]) {
      return send(res, 200, fs.readFileSync(path.join(HERE, 'player.html'), 'utf8'), 'text/html; charset=utf-8')
    }

    // GET /frames?version=N -> long-poll for frame changes
    if (req.method === 'GET' && parts[0] === 'frames') {
      const since = Number(url.searchParams.get('version') ?? -1)
      if (since >= version) {
        await new Promise(resolve => {
          const timer = setTimeout(resolve, LONG_POLL_MS)
          const wake = () => { clearTimeout(timer); resolve() }
          waiters.add(wake)
          req.on('close', wake)
        })
      }
      return send(res, 200, framesSnapshot())
    }

    send(res, 404, { error: 'not found' })
  } catch (err) {
    if (!err.needsLogin) log('request failed', err.stack ?? err)
    if (!res.headersSent) send(res, err.needsLogin ? 401 : 500, { error: String(err.message ?? err), needsLogin: Boolean(err.needsLogin) })
  }
})

function viewerUrl(id) {
  return `http://127.0.0.1:${server.address().port}/player/${encodeURIComponent(id)}?mode=auto&chrome=1&token=${TOKEN}`
}

// ------------------------------------------------------------------ the daemon

let touched = Date.now()
const IDLE_CHROME_MS = 10 * 60_000
const IDLE_EXIT_MS = 60 * 60_000
let shuttingDown = false

function shutdown() {
  if (shuttingDown) return
  shuttingDown = true
  for (const rec of recordings.values()) if (rec.status === 'live') endRecording(rec)
  chrome.stop()
  // Only ever the file naming this daemon: a successor may already have written its own.
  try { if (JSON.parse(fs.readFileSync(RELAY_FILE, 'utf8')).pid === process.pid) fs.unlinkSync(RELAY_FILE) } catch {}
  setTimeout(() => process.exit(0), 100)
}
process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)

setInterval(() => {
  const idle = Date.now() - touched
  if (players.size === 0 && idle > IDLE_CHROME_MS && chrome.ready) { chrome.stop() }
  if (bySession.size === 0 && players.size === 0 && waiters.size === 0 && idle > IDLE_EXIT_MS) shutdown()
}, 60_000).unref()

server.listen(0, '127.0.0.1', () => {
  const info = { pid: process.pid, port: server.address().port, token: TOKEN, version: RELAY_VERSION, dataDir: DATA_DIR, recordingsDir: REC_DIR }
  // Two daemons racing to start: the first to write the file is the one, the other leaves.
  try {
    fs.writeFileSync(RELAY_FILE, JSON.stringify(info) + '\n', { flag: 'wx', mode: 0o600 })
  } catch {
    log('another relay already owns', RELAY_FILE)
    process.exit(0)
  }
  log(`listening on ${info.port}`)
})
