#!/usr/bin/env node
// Local relay for the replayio plugin's inline Replay players (hooks/register.tsx).
//
// - Receives tracer packets (rrweb events + Replay simulation packets) from the
//   playwright-cli daemon via POST /ingest/:session and stores them per
//   recording, in memory and as NDJSON on disk so players survive restarts.
// - Serves player.html, which plays a recording with rrweb's Replayer, either
//   live (SSE) or from the start.
// - Renders players in a headless Chrome and screencasts them to PNG files the
//   mod shows inline in the transcript with an <Image>. GET /frames long-polls
//   for new frames.
//
// Zero dependencies: Node >= 22 (global fetch + WebSocket).
// Prints one JSON line on stdout once listening: { port, token, dataDir }.

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
const DATA_DIR = process.env.REPLAY_LIVE_DIR || path.join(os.homedir(), '.claude', 'replayio-live')
const REC_DIR = path.join(DATA_DIR, 'recordings')
const FRAME_DIR = path.join(DATA_DIR, 'frames')
const INJECT_DIR = path.join(DATA_DIR, 'inject')
const IMAGE_DIR = path.join(DATA_DIR, 'images')
const TOKEN = process.env.REPLAY_LIVE_TOKEN || crypto.randomUUID()
const PLAYER_W = 1280
const PLAYER_H = 800
const MAX_FPS = 12
const LONG_POLL_MS = 20_000

for (const dir of [REC_DIR, FRAME_DIR, INJECT_DIR, IMAGE_DIR]) fs.mkdirSync(dir, { recursive: true })

const log = (...args) => process.stderr.write(`[replayio-live relay] ${args.join(' ')}\n`)
const safeId = id => String(id).replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 120)

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
  const rec = {
    id, session, source, cwd, status: 'live', url: null, startedAt: Date.now(), endedAt: null,
    events: [], feed: [], activePage: null, clients: new Set(), meta: null,
    file: path.join(REC_DIR, `${safeId(id)}.ndjson`),
  }
  recordings.set(id, rec)
  appendLine(rec, { type: 'header', id, session, source, cwd, startedAt: rec.startedAt })
  return rec
}

function appendLine(rec, obj) {
  fs.appendFile(rec.file, JSON.stringify(obj) + '\n', err => err && log('append failed', err.message))
}

function loadRecording(id) {
  const existing = recordings.get(id)
  if (existing) return existing
  const file = path.join(REC_DIR, `${safeId(id)}.ndjson`)
  if (!fs.existsSync(file)) return null
  const rec = {
    id, session: id, source: 'disk', status: 'ended', url: null, startedAt: 0, endedAt: null,
    events: [], feed: [], activePage: null, clients: new Set(), meta: null, file,
  }
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line) continue
    try {
      const obj = JSON.parse(line)
      if (obj.type === 'header') Object.assign(rec, { session: obj.session, source: obj.source, startedAt: obj.startedAt, cwd: obj.cwd })
      else if (obj.type === 'events') applyEvents(rec, obj.events, false)
      else if (obj.type === 'feed') rec.feed.push(...obj.items)
      else if (obj.type === 'end') rec.endedAt = obj.endedAt
      else if (obj.type === 'replay') rec.replay = obj.recordings
      else if (obj.type === 'reset') rec.events = []
    } catch {}
  }
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
  if (persist) appendLine(rec, { type: 'events', events })
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
  appendLine(rec, { type: 'end', endedAt: rec.endedAt })
  broadcast(rec, 'status', { status: 'ended' })
  bump(rec.id)
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

const hostOf = url => { try { return new URL(url).host } catch { return null } }

/**
 * Finds the Replay Chromium recordings of a browser session: the ones that
 * started while it ran, of a page it visited. A session that ran in another
 * browser has none.
 */
async function linkReplay(rec) {
  const out = await replayio(['list', '--json'], 30_000)
  const list = JSON.parse(out.slice(out.indexOf('[')))
  const hosts = new Set([rec.url, ...rec.feed.filter(f => f.kind === 'nav').map(f => f.text)].map(hostOf).filter(Boolean))
  const from = rec.startedAt - 60_000
  const to = (rec.endedAt ?? Date.now()) + 15_000
  const found = list
    .filter(r => {
      const at = Date.parse(r.date)
      return at >= from && at <= to && (hosts.size === 0 || hosts.has(hostOf(r.metadata?.uri)))
    })
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

let login = null

/** Starts `replayio login` (an interactive browser sign-in) once; it finishes on its own. */
function startLogin() {
  if (login && login.exitCode === null) return
  login = spawn('replayio', ['login'], { stdio: 'ignore', detached: true })
  login.on('error', err => log('replayio login failed', err.message))
  login.unref()
}

/** Uploads a session's Replay recordings that are not uploaded yet. */
async function uploadReplay(rec) {
  const linked = rec.replay?.length ? rec.replay : await linkReplay(rec)
  const pending = linked.filter(r => r.uploadStatus !== 'uploaded' && r.recordingStatus !== 'recording').map(r => r.id)
  if (pending.length === 0 && linked.length === 0) throw new Error('no Replay recording was made for this session (was it Replay Chromium with RECORD_ALL_CONTENT=1?)')
  if (pending.length) {
    // `replayio upload` signed out starts an interactive browser sign-in and
    // waits on it; a button press must fail fast instead.
    const who = await replayio(['whoami'], 30_000).catch(err => err.message)
    if (!process.env.REPLAY_API_KEY && /not authenticated|log in/i.test(who)) {
      startLogin()
      const err = new Error('Sign in to Replay in the browser tab that just opened, then press Upload again.')
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
    durationMs: durationOf(rec.events), cwd: rec.cwd ?? null, replay: rec.replay ?? [],
    meta: rec.meta, lastError: [...rec.feed].reverse().find(f => f.kind === 'error')?.text ?? null,
  }
}

/** Every recording on disk, newest first, read without keeping their events. */
function listAll() {
  const out = []
  for (const name of fs.readdirSync(REC_DIR)) {
    if (!name.endsWith('.ndjson')) continue
    const loaded = recordings.get(name.slice(0, -'.ndjson'.length))
    if (loaded) { out.push(describe(loaded)); continue }
    const summary = { id: name.slice(0, -'.ndjson'.length), session: null, status: 'ended', url: null, startedAt: 0,
      endedAt: null, eventCount: 0, durationMs: 0, cwd: null, meta: null, lastError: null, replay: [] }
    let first = null
    let last = null
    for (const line of fs.readFileSync(path.join(REC_DIR, name), 'utf8').split('\n')) {
      if (!line) continue
      try {
        const obj = JSON.parse(line)
        if (obj.type === 'header') Object.assign(summary, { id: obj.id, session: obj.session, startedAt: obj.startedAt, cwd: obj.cwd ?? null })
        else if (obj.type === 'events') {
          for (const ev of obj.events) {
            first ??= ev.timestamp
            last = ev.timestamp
            if (ev.type === 4 && ev.data?.href) summary.url = ev.data.href
          }
          summary.eventCount += obj.events.length
        } else if (obj.type === 'end') summary.endedAt = obj.endedAt
        else if (obj.type === 'replay') summary.replay = obj.recordings
        else if (obj.type === 'feed') {
          const err = obj.items.filter(i => i.kind === 'error').pop()
          if (err) summary.lastError = err.text
        }
      } catch {}
    }
    summary.durationMs = first !== null && last !== null ? last - first + 1 : 0
    out.push(summary)
  }
  return out.sort((a, b) => b.startedAt - a.startedAt)
}

// ------------------------------------------------------------------- tracer

const TRACER = path.join(HERE, 'tracer.js')

/** The script injected into every page: session-recorder's capture, built by `npm run build`. */
function tracerSource() {
  if (!fs.existsSync(TRACER)) throw new Error(`missing ${TRACER}: run npm install && npm run build in ${HERE}`)
  return fs.readFileSync(TRACER, 'utf8')
}

/**
 * A `playwright-cli run-code --filename` script: exposes a binding that relays
 * packets from the daemon (so page CSP never blocks it), adds the tracer as an
 * init script for every later document, and evaluates it in the open pages.
 */
function writeInjectScript(session) {
  const ingestUrl = `http://127.0.0.1:${server.address().port}/ingest/${encodeURIComponent(session)}?token=${TOKEN}`
  const src = tracerSource()
  const script = `async page => {
  const ctx = page.context();
  const SRC = ${JSON.stringify(src)};
  ctx.__replayClaudeIngest = ${JSON.stringify(ingestUrl)};
  if (!ctx.__replayClaudeLive) {
    ctx.__replayClaudeLive = true;
    const ids = new WeakMap();
    let next = 0;
    try {
      await ctx.exposeBinding('__replayClaudeEmit', async (source, data) => {
        let id = ids.get(source.page);
        if (!id) { id = ++next; ids.set(source.page, id); }
        try {
          await fetch(ctx.__replayClaudeIngest, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ page: id, url: source.page.url(), packets: JSON.parse(data) }),
          });
        } catch {}
      });
    } catch (err) {
      if (!/already registered/i.test(String(err))) throw err;
    }
    await ctx.addInitScript({ content: SRC });
  }
  for (const p of ctx.pages()) await p.evaluate(SRC).catch(() => {});
  return 'Replay live tracer attached';
}
`
  const file = path.join(INJECT_DIR, `${safeId(session)}.js`)
  fs.writeFileSync(file, script)
  return file
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
    out[id] = { ...f, recording: rec ? describe(rec) : null, export: exportJobs.get(id) ?? null }
  }
  return { version, frames: out }
}

// ------------------------------------------------------------------- export

/** recording id -> { status, progress, files, error } */
const exportJobs = new Map()
const EXPORT_FPS = 15
const IDLE_GAP_MS = 2000
const IDLE_KEPT_MS = 800

const stampOf = ms => new Date(ms || Date.now()).toISOString().replace(/[:]/g, '-').replace(/\..+$/, '')

/**
 * Video time -> recording time, with idle stretches (gaps between events over
 * IDLE_GAP_MS) fast-forwarded into IDLE_KEPT_MS, as rrweb's skipInactive does.
 */
function timeline(times) {
  const knots = [[0, 0]]
  let video = 0
  for (let i = 1; i < times.length; i++) {
    const gap = times[i] - times[i - 1]
    if (gap <= 0) continue
    video += gap > IDLE_GAP_MS ? IDLE_KEPT_MS : gap
    knots.push([video, times[i]])
  }
  const end = knots[knots.length - 1]
  // Hold the last frame a moment, 1ms past the last event so it is applied.
  knots.push([video + 600, end[1] + 1])
  return {
    duration: video + 600,
    at(v) {
      let lo = 0
      let hi = knots.length - 1
      while (lo < hi - 1) {
        const mid = (lo + hi) >> 1
        if (knots[mid][0] <= v) lo = mid
        else hi = mid
      }
      const [v0, t0] = knots[lo]
      const [v1, t1] = knots[hi]
      return v1 === v0 ? t0 : t0 + ((v - v0) / (v1 - v0)) * (t1 - t0)
    },
  }
}

function startExport(id, { outDir, formats = ['mp4', 'rrweb'] }) {
  const running = exportJobs.get(id)
  if (running?.status === 'running') return running
  const rec = loadRecording(id)
  if (!rec) throw new Error(`no recording ${id}`)
  const dir = path.resolve(outDir || path.join(rec.cwd || process.cwd(), '.replay', 'live'))
  const base = path.join(dir, `${stampOf(rec.startedAt)}-${safeId(rec.session)}`)
  const job = { status: 'running', progress: 0, files: [], error: null }
  exportJobs.set(id, job)
  bump(id)
  void (async () => {
    try {
      fs.mkdirSync(dir, { recursive: true })
      if (formats.includes('rrweb')) {
        // A plain rrweb event array: loads in rrweb-player or any Replayer.
        fs.writeFileSync(`${base}.rrweb.json`, JSON.stringify(rec.events))
        job.files.push(`${base}.rrweb.json`)
      }
      if (formats.includes('mp4')) {
        await exportMp4(rec, `${base}.mp4`, p => { job.progress = p; bump(id) })
        job.files.push(`${base}.mp4`)
      }
      job.status = 'done'
      job.progress = 1
    } catch (err) {
      job.status = 'failed'
      job.error = String(err.message ?? err)
      log('export failed', job.error)
    }
    bump(id)
  })()
  return job
}

/** Renders the recording frame by frame (seek, paint, screenshot) into ffmpeg. */
async function exportMp4(rec, file, onProgress) {
  if (rec.events.length < 2) throw new Error('nothing recorded to export')
  const { width, height } = playerSize(rec)
  const port = server.address().port
  const url = `http://127.0.0.1:${port}/player/${encodeURIComponent(rec.id)}?mode=export&token=${TOKEN}&chrome=0`
  const target = await openTarget(url, width, height, () => {})
  let ffmpeg
  try {
    await waitReady(target.sessionId)
    const map = timeline(await evaluate(target.sessionId, '__ctl.eventTimes()'))
    const count = Math.max(1, Math.ceil((map.duration / 1000) * EXPORT_FPS) + 1)
    ffmpeg = spawn('ffmpeg', [
      '-y', '-loglevel', 'error', '-f', 'image2pipe', '-vcodec', 'mjpeg', '-framerate', String(EXPORT_FPS), '-i', '-',
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2', '-movflags', '+faststart', file,
    ], { stdio: ['pipe', 'ignore', 'pipe'] })
    let ffErr = ''
    ffmpeg.stderr.on('data', c => { ffErr += c })
    const exited = new Promise((resolve, reject) => {
      ffmpeg.on('error', err => reject(new Error(`ffmpeg: ${err.message}`)))
      ffmpeg.on('exit', code => (code === 0 ? resolve() : reject(new Error(`ffmpeg exited ${code}: ${ffErr.slice(-300)}`))))
    })
    exited.catch(() => {})
    for (let k = 0; k < count; k++) {
      await evaluate(target.sessionId, `__ctl.frameAt(${map.at((k * 1000) / EXPORT_FPS)})`)
      const { data } = await chrome.send('Page.captureScreenshot', { format: 'jpeg', quality: 85 }, target.sessionId)
      if (!ffmpeg.stdin.write(Buffer.from(data, 'base64'))) await new Promise(r => ffmpeg.stdin.once('drain', r))
      if (k % 10 === 0) onProgress(k / count)
    }
    ffmpeg.stdin.end()
    await exited
  } finally {
    if (ffmpeg && ffmpeg.exitCode === null) ffmpeg.stdin.end()
    await closeTarget(target)
  }
}

// ------------------------------------------------------------------- images

const converting = new Map()

/**
 * A local PNG of a remote image, for the terminal's Image (which draws PNG
 * files): a PNG is saved as is, anything else is drawn in the renderer and
 * screenshotted. Cached by URL.
 */
function imageAsPng(url) {
  const file = path.join(IMAGE_DIR, `${crypto.createHash('sha1').update(url).digest('hex')}.png`)
  if (fs.existsSync(file)) return Promise.resolve(file)
  if (converting.has(url)) return converting.get(url)
  const job = (async () => {
    const res = await fetch(url)
    if (!res.ok) throw new Error(`image fetch ${res.status}`)
    const bytes = Buffer.from(await res.arrayBuffer())
    const type = res.headers.get('content-type') ?? 'image/jpeg'
    if (type.includes('png')) {
      fs.writeFileSync(file, bytes)
      return file
    }
    const html = `<html><body style="margin:0;background:#000"><img id=i src="data:${type};base64,${bytes.toString('base64')}"></body></html>`
    const target = await openTarget(`data:text/html;base64,${Buffer.from(html).toString('base64')}`, 1280, 800, () => {})
    try {
      let size = null
      for (let i = 0; i < 50 && !size; i++) {
        size = await evaluate(target.sessionId, 'document.getElementById("i") && document.getElementById("i").complete && document.getElementById("i").naturalWidth ? [document.getElementById("i").naturalWidth, document.getElementById("i").naturalHeight] : null').catch(() => null)
        if (!size) await new Promise(r => setTimeout(r, 100))
      }
      if (!size) throw new Error('image did not load')
      const scale = Math.min(1, 1600 / size[0])
      const width = Math.round(size[0] * scale)
      const height = Math.round(size[1] * scale)
      await chrome.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false }, target.sessionId)
      await evaluate(target.sessionId, `(document.getElementById("i").style.width = "${width}px", true)`)
      const { data } = await chrome.send('Page.captureScreenshot', { format: 'png', clip: { x: 0, y: 0, width, height, scale: 1 } }, target.sessionId)
      fs.writeFileSync(file, Buffer.from(data, 'base64'))
      return file
    } finally {
      await closeTarget(target)
    }
  })()
  converting.set(url, job)
  job.finally(() => converting.delete(url)).catch(() => {})
  return job
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

    // POST /recordings { id, session, source? } -> start a recording for a session
    if (req.method === 'POST' && parts[0] === 'recordings' && parts.length === 1) {
      const { id, session, source = 'playwright-cli' } = await readJson(req)
      if (!id || !session) return send(res, 400, { error: 'id and session required' })
      const previous = bySession.get(session)
      if (previous && previous !== id) {
        const prev = recordings.get(previous)
        if (prev) endRecording(prev)
      }
      const rec = recordings.get(id) ?? newRecording(id, session, source)
      rec.status = 'live'
      bySession.set(session, id)
      const injectPath = writeInjectScript(session)
      return send(res, 200, { recording: describe(rec), injectPath, viewerUrl: viewerUrl(id) })
    }

    // POST /sessions/:session/end
    if (req.method === 'POST' && parts[0] === 'sessions' && parts[2] === 'end') {
      const id = bySession.get(parts[1])
      const rec = id && recordings.get(id)
      if (rec) {
        endRecording(rec)
        const live = players.get(id)
        // Park the inline player on the finished recording's last moment.
        if (live?.mode === 'live') setTimeout(() => { if (players.get(id) === live) void control(id, 'seek', durationOf(rec.events)) }, 1500)
      }
      return send(res, 200, { ended: rec ? rec.id : null })
    }

    // POST /ingest/:session { page, url, packets }
    if (req.method === 'POST' && parts[0] === 'ingest') {
      const { page = 0, url: pageUrl, packets = [] } = await readJson(req)
      return send(res, 200, { accepted: ingest(parts[1], page, pageUrl, packets) })
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

      // POST /recordings/:id/export { outDir?, formats? } -> saves .mp4 + .rrweb.json
      if (req.method === 'POST' && parts[2] === 'export') {
        return send(res, 200, startExport(rec.id, await readJson(req)))
      }
      if (req.method === 'GET' && parts[2] === 'export') return send(res, 200, exportJobs.get(rec.id) ?? null)

      // GET /recordings/:id/replay -> re-match its Replay recordings; POST .../replay/upload uploads them
      if (req.method === 'GET' && parts[2] === 'replay') return send(res, 200, await linkReplay(rec))
      if (req.method === 'POST' && parts[2] === 'replay' && parts[3] === 'upload') return send(res, 200, await uploadReplay(rec))
    }

    // GET /player/:id -> the page the headless renderer (or a person) loads
    if (req.method === 'GET' && parts[0] === 'player' && parts[1]) {
      return send(res, 200, fs.readFileSync(path.join(HERE, 'player.html'), 'utf8'), 'text/html; charset=utf-8')
    }

    // GET /library -> every saved recording
    if (req.method === 'GET' && parts[0] === 'library') {
      return send(res, 200, fs.readFileSync(path.join(HERE, 'library.html'), 'utf8'), 'text/html; charset=utf-8')
    }

    // GET /image?url=... -> { file, width, height }: a local PNG of a remote image (Replay screenshots)
    if (req.method === 'GET' && parts[0] === 'image') {
      const remote = url.searchParams.get('url') ?? ''
      if (!/^https:\/\/[a-z0-9.-]*replay\.io\//.test(remote)) return send(res, 400, { error: 'only replay.io images' })
      const file = await imageAsPng(remote)
      // A PNG's IHDR holds its size at bytes 16-23.
      const head = Buffer.alloc(24)
      const fd = fs.openSync(file, 'r')
      fs.readSync(fd, head, 0, 24, 0)
      fs.closeSync(fd)
      return send(res, 200, { file, width: head.readUInt32BE(16), height: head.readUInt32BE(20) })
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

server.listen(Number(process.env.REPLAY_LIVE_PORT ?? 0), '127.0.0.1', () => {
  process.stdout.write(JSON.stringify({ port: server.address().port, token: TOKEN, dataDir: DATA_DIR }) + '\n')
})

const shutdown = () => {
  chrome.stop()
  process.exit(0)
}
process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)
// The mod's spawn kills us when it lets go; if Claude Code itself dies we are
// reparented, so exit rather than linger with a headless Chrome.
const parent = process.ppid
setInterval(() => { if (process.ppid !== parent) shutdown() }, 5_000).unref()
