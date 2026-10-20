#!/usr/bin/env node
// Local relay for the replay-qa plugin's live views (hooks/register.tsx).
//
// - Reads Replay QA recordings from the QA API (recording-events), live while an exploration
//   or journey test run executes and from the saved stream afterwards, and keeps each one as
//   rrweb events in memory and as NDJSON on disk.
// - Follows a project: any exploration, test run or task that is running gets a recording
//   automatically, so every live journey streams in parallel.
// - Serves player.html (one recording) and canvas.html (every journey of a project as a grid of
//   rrweb players), and screencasts either to a PNG the terminal shows with an <Image>.
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

import { AuthError, NotFoundError, RecordingStream, apiBaseOf, tunnelServers } from './qa-stream.mjs'

/** live/: this script, the pages and vendor/. */
const HERE = path.dirname(fileURLToPath(import.meta.url))
const DATA_DIR = process.env.REPLAY_QA_LIVE_DIR || path.join(os.homedir(), '.claude', 'replay-qa-live')
const REC_DIR = path.join(DATA_DIR, 'recordings')
const FRAME_DIR = path.join(DATA_DIR, 'frames')
const TOKEN = process.env.REPLAY_QA_LIVE_TOKEN || crypto.randomUUID()
const SERVERS_FILE = path.join(DATA_DIR, 'servers.json')
const PLAYER_W = 1280
const PLAYER_H = 800
const CANVAS_W = 1600
const CANVAS_H = 900
const MAX_FPS = 12
const LONG_POLL_MS = 20_000
const FOLLOW_MS = 4_000
const LIVE_POLL_MS = 1_000
/** However many recordings are live, a project is read from the API at most this often. */
const PROJECT_MAX_AGE_MS = 3_000
const MAX_API_CONCURRENCY = 4
/** Recordings kept in memory with their events; older finished ones are re-read from disk. */
const MAX_RESIDENT = 8

for (const dir of [REC_DIR, FRAME_DIR]) fs.mkdirSync(dir, { recursive: true })

const log = (...args) => process.stderr.write(`[replay-qa-live relay] ${args.join(' ')}\n`)
const safeId = id => String(id).replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 120)
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

// ------------------------------------------------------------------- QA API

const DEFAULT_API_BASE = apiBaseOf(process.env.REPLAY_QA_API_BASE) ?? apiBaseOf(process.env.REPLAY_QA_URL) ?? 'https://qa.replay.io/api/v1'

/**
 * project id -> the QA server it lives on, when it is not the default one (a PR preview, staging).
 * Told by the hooks module (what a script ran against, a pasted URL) and kept across restarts.
 * @type {Map<string, string>}
 */
const projectServers = new Map(Object.entries((() => {
  try { return JSON.parse(fs.readFileSync(SERVERS_FILE, 'utf8')) } catch { return {} }
})()).filter(([, base]) => apiBaseOf(base)))

function setProjectServer(projectId, value) {
  const base = apiBaseOf(value)
  if (!base || projectServers.get(projectId) === base) return false
  projectServers.set(projectId, base)
  fs.writeFile(SERVERS_FILE, JSON.stringify(Object.fromEntries(projectServers), null, 2), err => err && log('servers write failed', err.message))
  return true
}

/**
 * The QA servers of running tunnels: `replayqa proxy|run --project <id> --qa-url <url>`, the command
 * a QA server's reverse-proxy runbook gives with its own URL. Read from `ps` at most every few seconds.
 */
let tunnels = { at: 0, map: new Map(), pending: null }
function runningTunnels() {
  if (Date.now() - tunnels.at < 5_000) return Promise.resolve(tunnels.map)
  tunnels.pending ??= new Promise(resolve => {
    execFile('ps', ['-axww', '-o', 'command='], { timeout: 5_000, maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => {
      tunnels = { at: Date.now(), map: err ? tunnels.map : tunnelServers(String(stdout)), pending: null }
      resolve(tunnels.map)
    })
  })
  return tunnels.pending
}

/** Where a project's API lives: the server it was named with, else its running tunnel's, else the default. */
async function apiBaseFor(projectId) {
  if (!projectId) return DEFAULT_API_BASE
  return projectServers.get(projectId) ?? (await runningTunnels()).get(projectId) ?? DEFAULT_API_BASE
}

function authToken() {
  const env = process.env.REPLAY_QA_API_KEY || process.env.REPLAY_API_KEY || process.env.REPLAY_ACCESS_TOKEN
  if (env && env.trim()) return env.trim()
  try {
    const profile = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.replay', 'profile', 'auth.json'), 'utf8'))
    const find = o => {
      if (!o || typeof o !== 'object') return undefined
      if (typeof o.accessToken === 'string') return o.accessToken
      for (const v of Object.values(o)) { const r = find(v); if (r) return r }
    }
    const token = find(profile)
    if (token) return token
  } catch {}
  throw new AuthError('No Replay QA token: run `replayio login`, or set REPLAY_QA_API_KEY')
}

let inFlight = 0
const queue = []
/** At most MAX_API_CONCURRENCY requests at once, however many recordings stream. */
async function slot() {
  if (inFlight >= MAX_API_CONCURRENCY) await new Promise(resolve => queue.push(resolve))
  inFlight++
}
function release() {
  inFlight--
  queue.shift()?.()
}

/** GET/POST against the QA API: `{ status, data }`; the token is read each time so a refresh is picked up. */
async function request(apiPath, { method = 'GET', body } = {}) {
  const projectId = /^\/projects\/([^/?]+)/.exec(apiPath)?.[1]
  const apiBase = await apiBaseFor(projectId && decodeURIComponent(projectId))
  await slot()
  try {
    const res = await fetch(`${apiBase}${apiPath}`, {
      method,
      headers: { authorization: `Bearer ${authToken()}`, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(60_000),
    })
    const text = await res.text()
    let data
    try { data = text ? JSON.parse(text) : {} } catch { data = text }
    return { status: res.status, data }
  } finally {
    release()
  }
}

// ---------------------------------------------------------------- recordings

/**
 * @typedef {{ id: string, kind: 'task'|'test_run'|'exploration', projectId: string, sourceId: string,
 *   title: string, goal: string|null, status: 'loading'|'live'|'ended'|'error', error: string|null,
 *   url: string|null, startedAt: number, endedAt: number|null, events: any[], feed: any[],
 *   eventCount: number, firstTs: number|null, lastTs: number|null, loadedPages: number,
 *   clients: Set<http.ServerResponse>, meta: { width: number, height: number }|null, file: string,
 *   touched: number, evicted: boolean }} Recording
 */
/** @type {Map<string, Recording>} */
const recordings = new Map()

const ID_PREFIX = { test_run: 'run', exploration: 'expl', task: 'task' }
/** The server's ids already start `run-`, `expl-` or `task-`; anything else gets that prefix. */
const recordingId = (kind, sourceId) => safeId(String(sourceId).startsWith(`${ID_PREFIX[kind]}-`) ? sourceId : `${ID_PREFIX[kind]}-${sourceId}`)

function appendLine(rec, obj) {
  fs.appendFile(rec.file, JSON.stringify(obj) + '\n', err => err && log('append failed', err.message))
}

function newRecording({ kind, projectId, sourceId, title, goal }) {
  const id = recordingId(kind, sourceId)
  /** @type {Recording} */
  const rec = {
    id, kind, projectId, sourceId, title: title || sourceId, goal: goal ?? null, status: 'loading', error: null,
    url: null, startedAt: Date.now(), endedAt: null, events: [], feed: [], eventCount: 0, firstTs: null, lastTs: null,
    loadedPages: 0, clients: new Set(), meta: null, file: path.join(REC_DIR, `${id}.ndjson`), touched: Date.now(), evicted: false,
  }
  recordings.set(id, rec)
  return rec
}

/** Reads a finished recording back from disk; null when there is none or it never finished. */
function readCache(file) {
  let text
  try { text = fs.readFileSync(file, 'utf8') } catch { return null }
  const cache = { header: null, events: [], feed: [], ended: false }
  for (const line of text.split('\n')) {
    if (!line) continue
    try {
      const obj = JSON.parse(line)
      if (obj.type === 'header') cache.header = obj
      else if (obj.type === 'events') cache.events.push(...obj.events)
      else if (obj.type === 'feed') cache.feed.push(...obj.items)
      else if (obj.type === 'end') cache.ended = true
    } catch {}
  }
  return cache.header ? cache : null
}

function applyEvents(rec, events) {
  for (const ev of events) {
    rec.events.push(ev)
    rec.eventCount++
    if (typeof ev.timestamp === 'number') {
      rec.firstTs ??= ev.timestamp
      rec.lastTs = Math.max(rec.lastTs ?? 0, ev.timestamp)
    }
    if (ev.type === 4 && ev.data) {
      rec.meta = { width: ev.data.width, height: ev.data.height }
      if (ev.data.href) rec.url = ev.data.href
    }
  }
}

function broadcast(rec, event, data) {
  const chunk = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
  for (const res of rec.clients) res.write(chunk)
}

/** The player subtitle / banner entry for a narration row. */
function feedItem(row) {
  return row.type === 'error'
    ? { kind: 'error', text: row.text, time: row.ts }
    : { kind: 'note', type: row.type, text: row.text, time: row.ts, ...(row.step ? { step: row.step } : {}) }
}

function applyRows(rec, rows) {
  const events = []
  const items = []
  for (const row of rows) {
    if (row.kind === 'rrweb') events.push(row.event)
    else if (row.text) items.push(feedItem(row))
  }
  if (events.length) {
    const from = rec.eventCount
    applyEvents(rec, events)
    appendLine(rec, { type: 'events', events })
    broadcast(rec, 'events', { from, events })
  }
  if (items.length) {
    rec.feed.push(...items)
    appendLine(rec, { type: 'feed', items })
    broadcast(rec, 'feed', items)
  }
  if (events.length || items.length) bump(rec.id)
}

function durationOf(rec) {
  return rec.firstTs !== null && rec.lastTs !== null ? rec.lastTs - rec.firstTs + 1 : 0
}

function describe(rec) {
  const lastNote = [...rec.feed].reverse().find(f => f.kind === 'note')
  const lastError = [...rec.feed].reverse().find(f => f.kind === 'error')
  return {
    id: rec.id, kind: rec.kind, projectId: rec.projectId, sourceId: rec.sourceId, title: rec.title, goal: rec.goal,
    status: rec.status, error: rec.error, url: rec.url, startedAt: rec.startedAt, endedAt: rec.endedAt,
    eventCount: rec.eventCount, durationMs: durationOf(rec), pages: rec.loadedPages, meta: rec.meta,
    note: lastNote ? { text: lastNote.text, type: lastNote.type, step: lastNote.step ?? null } : null,
    lastError: lastError?.text ?? null,
  }
}

/** Puts an evicted recording's events back in memory from its NDJSON. */
function hydrate(rec) {
  if (!rec.evicted) return rec
  const cache = readCache(rec.file)
  rec.events = []
  rec.eventCount = 0
  rec.firstTs = rec.lastTs = null
  if (cache) {
    applyEvents(rec, cache.events)
    rec.feed = cache.feed
  }
  rec.evicted = false
  return rec
}

/** Finished recordings nobody is watching give their events back to disk, oldest first. */
function evictIdle() {
  const resident = [...recordings.values()].filter(r => !r.evicted && r.events.length)
  if (resident.length <= MAX_RESIDENT) return
  const idle = resident
    .filter(r => r.status === 'ended' && r.clients.size === 0 && !players.has(r.id) && Date.now() - r.touched > 30_000)
    .sort((a, b) => a.touched - b.touched)
  for (const rec of idle.slice(0, resident.length - MAX_RESIDENT)) {
    rec.events = []
    rec.evicted = true
  }
}
setInterval(evictIdle, 15_000).unref()

// ---------------------------------------------------------- headless renderer


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

// ------------------------------------------------------------------ project state

const SOURCE_KEY = { task: 'task_id', test_run: 'test_run_id', exploration: 'exploration_id' }

/** project id -> { project, journeys, runs, explorations, liveTasks, updatedAt, error, refreshing } */
const projects = new Map()
/** project ids whose running work is turned into recordings automatically. */
const followed = new Set()

const itemsOf = data => (Array.isArray(data) ? data : data?.items ?? [])

async function refreshProject(projectId, { maxAge = 0 } = {}) {
  let state = projects.get(projectId)
  if (!state) projects.set(projectId, (state = { project: null, journeys: [], runs: [], explorations: [], liveTasks: [], updatedAt: 0, error: null, refreshing: null }))
  if (state.refreshing) return state.refreshing
  if (maxAge && Date.now() - state.updatedAt < maxAge) return state
  state.refreshing = (async () => {
    try {
      const enc = encodeURIComponent(projectId)
      const [project, journeys, runs, explorations, running, queued] = await Promise.all([
        request(`/projects/${enc}`),
        request(`/projects/${enc}/journeys?page=1&page_size=100`),
        request(`/projects/${enc}/test-runs?page=1&page_size=100`),
        request(`/projects/${enc}/explorations?page=1&page_size=20`),
        request(`/projects/${enc}/tasks?status=running&page=1&page_size=50`),
        request(`/projects/${enc}/tasks?status=queued&page=1&page_size=50`),
      ])
      for (const r of [project, journeys, runs]) {
        if (r.status === 401 || r.status === 403) throw new AuthError(`Replay QA answered ${r.status}: run \`replayio login\``)
        if (r.status === 404) throw new NotFoundError(`No Replay QA project ${projectId} on ${new URL(await apiBaseFor(projectId)).host}: for a PR preview or staging, open the canvas with its dashboard URL`)
        if (r.status !== 200) throw new Error(`Replay QA answered ${r.status} for project ${projectId}`)
      }
      const p = project.data
      state.server = await apiBaseFor(projectId)
      state.project = { id: p.id, name: p.name, target_url: p.target_url, status: p.status }
      state.journeys = itemsOf(journeys.data)
      state.runs = itemsOf(runs.data)
      state.explorations = explorations.status === 200 ? itemsOf(explorations.data) : []
      state.liveTasks = [...itemsOf(running.data), ...itemsOf(queued.data)]
      state.error = null
      state.updatedAt = Date.now()
    } catch (err) {
      state.error = err.message
      state.updatedAt = Date.now()
    } finally {
      state.refreshing = null
    }
    if (followed.has(projectId)) followLive(projectId)
    return state
  })()
  return state.refreshing
}

const LIVE_RUN = new Set(['in-progress', 'running', 'queued', 'pending'])
const LIVE_EXPLORATION = new Set(['in-progress', 'pending', 'running'])

function isLiveRun(run) { return LIVE_RUN.has(run.status) }

/** Is this source still producing events, going by what the last refresh saw? */
function sourceIsLive(projectId, kind, sourceId) {
  const state = projects.get(projectId)
  if (!state) return true
  const tasks = state.liveTasks
  if (kind === 'task') return tasks.some(t => t.id === sourceId)
  if (kind === 'test_run') return tasks.some(t => t.test_run_id === sourceId) || state.runs.some(r => r.id === sourceId && isLiveRun(r))
  return tasks.some(t => t.exploration_id === sourceId) || state.explorations.some(e => e.id === sourceId && LIVE_EXPLORATION.has(e.status))
}

/** Gives every running exploration and test run of a followed project a recording. */
function followLive(projectId) {
  const state = projects.get(projectId)
  if (!state || state.error) return
  for (const run of state.runs) {
    if (isLiveRun(run)) void watch({ projectId, kind: 'test_run', sourceId: run.id, title: run.goal || run.journey_name || run.id, goal: run.goal })
  }
  for (const e of state.explorations) {
    if (LIVE_EXPLORATION.has(e.status)) void watch({ projectId, kind: 'exploration', sourceId: e.id, title: `Exploration: ${String(e.prompt ?? '').slice(0, 60)}`, goal: e.prompt })
  }
}

setInterval(() => {
  for (const projectId of followed) void refreshProject(projectId, { maxAge: FOLLOW_MS - 500 })
}, FOLLOW_MS).unref()

/** The canvas: one tile per journey (its latest run), live work first, then explorations. */
function overview(projectId) {
  const state = projects.get(projectId)
  if (!state) return null
  const runById = new Map(state.runs.map(r => [r.id, r]))
  const tiles = []
  const used = new Set()
  const tileOf = run => {
    const live = isLiveRun(run)
    const status = live ? 'live'
      : run.status === 'completed' ? (run.bugs_found_count > 0 ? 'bugs' : 'passed')
        : run.status === 'failed' ? 'failed'
          : run.status === 'infra-failed' ? 'infra' : 'incomplete'
    return {
      key: `run:${run.id}`, kind: 'test_run', sourceId: run.id, recordingId: recordingId('test_run', run.id), journeyId: run.journey_id ?? null,
      title: run.journey_name || run.goal || run.id, goal: run.goal ?? null, status, isLive: live,
      bugs: run.bugs_found_count ?? 0, bugTitles: run.bug_titles ?? [], startedAt: run.started_at ?? run.created_at ?? null,
      durationSeconds: run.duration_seconds ?? null, environment: run.environment_name ?? null, reason: run.outcome_reason ?? null,
    }
  }
  for (const run of state.runs) {
    if (isLiveRun(run)) { tiles.push(tileOf(run)); used.add(run.id) }
  }
  for (const e of state.explorations) {
    if (LIVE_EXPLORATION.has(e.status)) {
      tiles.push({
        key: `expl:${e.id}`, kind: 'exploration', sourceId: e.id, recordingId: recordingId('exploration', e.id), journeyId: null,
        title: `Exploration: ${String(e.prompt ?? '').slice(0, 70)}`, goal: e.prompt ?? null, status: 'live', isLive: true,
        bugs: 0, bugTitles: [], startedAt: e.started_at ?? e.created_at ?? null, durationSeconds: null, environment: null, reason: null,
      })
    }
  }
  for (const journey of state.journeys) {
    const runId = journey.preview_run_id ?? journey.last_run_id
    const run = runId ? runById.get(runId) : undefined
    if (run && used.has(run.id)) continue
    if (run) { tiles.push({ ...tileOf(run), journeyId: journey.id, title: journey.name || run.journey_name }); used.add(run.id); continue }
    // The run is older than the page of runs read: show the journey's own summary, loadable by id.
    if (runId) {
      const s = journey.last_run_status
      tiles.push({
        key: `run:${runId}`, kind: 'test_run', sourceId: runId, recordingId: recordingId('test_run', runId), journeyId: journey.id,
        title: journey.name, goal: null, status: s === 'completed' ? (journey.last_run_bug_id ? 'bugs' : 'passed') : s === 'failed' ? 'failed' : 'incomplete', isLive: false,
        bugs: journey.last_run_bug_id ? 1 : 0, bugTitles: journey.last_run_bug_title ? [journey.last_run_bug_title] : [], startedAt: journey.last_run_at ?? null,
        durationSeconds: null, environment: null, reason: null,
      })
    } else {
      tiles.push({ key: `journey:${journey.id}`, kind: 'journey', sourceId: journey.id, recordingId: null, journeyId: journey.id, title: journey.name, goal: null, status: 'never-run', isLive: false, bugs: 0, bugTitles: [], startedAt: null, durationSeconds: null, environment: null, reason: null })
    }
  }
  const finished = state.explorations.filter(e => !LIVE_EXPLORATION.has(e.status)).slice(0, 3)
  for (const e of finished) {
    tiles.push({
      key: `expl:${e.id}`, kind: 'exploration', sourceId: e.id, recordingId: recordingId('exploration', e.id), journeyId: null,
      title: `Exploration: ${String(e.prompt ?? '').slice(0, 70)}`, goal: e.prompt ?? null, status: e.status === 'completed' ? 'passed' : 'failed', isLive: false,
      bugs: 0, bugTitles: [], startedAt: e.started_at ?? null, durationSeconds: null, environment: null, reason: null,
    })
  }
  return {
    project: state.project, server: state.server && state.server !== DEFAULT_API_BASE ? state.server : null, error: state.error, updatedAt: state.updatedAt, following: followed.has(projectId),
    counts: {
      live: tiles.filter(t => t.isLive).length,
      journeys: state.journeys.length,
      bugs: tiles.filter(t => t.status === 'bugs').length,
      failed: tiles.filter(t => t.status === 'failed').length,
    },
    tiles: tiles.map(t => ({ ...t, loaded: recordings.has(t.recordingId ?? '') ? describe(recordings.get(t.recordingId)) : null })),
  }
}

// ------------------------------------------------------------------ watching

/** recording id -> the loop reading it */
const loops = new Map()

/**
 * Starts (once) the reading of one source into a recording: a finished one is read back from
 * disk if saved there, else fetched; a running one is followed until the API says it is done.
 */
async function watch({ projectId, kind, sourceId, title, goal }) {
  const id = recordingId(kind, sourceId)
  let rec = recordings.get(id)
  if (rec) {
    rec.touched = Date.now()
    if (rec.evicted) hydrate(rec)
    if (rec.status === 'error' && !loops.has(id)) { rec.status = 'loading'; rec.error = null } else return rec
  }
  const cache = readCache(path.join(REC_DIR, `${id}.ndjson`))
  if (!rec) {
    rec = newRecording({ kind, projectId, sourceId, title, goal })
    if (cache?.ended) {
      applyEvents(rec, cache.events)
      rec.feed = cache.feed
      rec.status = 'ended'
      rec.endedAt = Date.now()
      return rec
    }
    // A partial file (the relay stopped mid-run) is discarded and fetched again.
    fs.rmSync(rec.file, { force: true })
    appendLine(rec, { type: 'header', id, kind, projectId, sourceId, title: rec.title, goal: rec.goal, startedAt: rec.startedAt })
  }
  const done = readLoop(rec).catch(err => log('read failed', rec.id, err.message)).finally(() => loops.delete(id))
  loops.set(id, done)
  return rec
}

async function readLoop(rec) {
  const stream = new RecordingStream({ request, projectId: rec.projectId, key: SOURCE_KEY[rec.kind], id: rec.sourceId })
  const catchUp = async () => {
    for (let more = true; more;) {
      const page = await stream.pull()
      rec.loadedPages++
      more = page.hasMore
      applyRows(rec, page.rows)
    }
  }
  try {
    for (;;) {
      await catchUp()
      await refreshProject(rec.projectId, { maxAge: PROJECT_MAX_AGE_MS }).catch(() => {})
      const live = sourceIsLive(rec.projectId, rec.kind, rec.sourceId)
      rec.status = live ? 'live' : rec.status === 'loading' ? 'loading' : rec.status
      if (!live) {
        // Rows can land just after the status flips: read once more before closing.
        await sleep(1_500)
        await catchUp()
        break
      }
      bump(rec.id)
      await sleep(LIVE_POLL_MS)
    }
    rec.status = 'ended'
    rec.endedAt = Date.now()
    appendLine(rec, { type: 'end', endedAt: rec.endedAt })
  } catch (err) {
    rec.status = 'error'
    rec.error = err.message
  }
  broadcast(rec, 'status', { status: rec.status })
  bump(rec.id)
}

// ---------------------------------------------------------------- screencasts

/** view id -> { targetId, sessionId, kind, mode, touched, lastWrite, timer, pendingFrame } */
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

/**
 * Screencasts a relay page to FRAME_DIR/<id>.png, throttled to MAX_FPS. `kind` is
 * 'recording' (one player; its page reports play state) or 'canvas'.
 */
async function startView(id, url, width, height, { kind, mode, paused = false, t = 0, totalMs = 0 }) {
  await stopPlayer(id)
  if (players.size >= MAX_PLAYERS) {
    const [oldest] = [...players.entries()].filter(([, p]) => p.kind !== 'canvas').sort((a, b) => a[1].touched - b[1].touched)
    if (oldest) await stopPlayer(oldest[0])
  }
  const frameFile = path.join(FRAME_DIR, `${safeId(id)}.png`)
  const entry = frames.get(id) ?? { file: frameFile, generation: 0, seq: 0 }
  frames.set(id, {
    ...entry, kind, width, height, mode, status: paused ? 'paused' : 'playing',
    currentMs: t, totalMs, at: Date.now(), seq: (entry.seq ?? 0) + 1,
  })
  const player = { kind, mode, touched: Date.now(), lastWrite: 0, timer: null, pendingFrame: null }
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
    } else if (kind === 'recording' && method === 'Runtime.bindingCalled' && params.name === '__playerEvent') {
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

/**
 * Starts the screencast player for a recording: `live` follows the stream (frames until it
 * ends), `replay` plays (or, `paused`, parks at `t`) what has been read.
 */
async function startPlayer(id, mode, { t = 0, paused = false } = {}) {
  const rec = recordings.get(id)
  if (!rec) throw new Error(`no recording ${id}`)
  if (rec.evicted) hydrate(rec)
  rec.touched = Date.now()
  const { width, height } = playerSize(rec)
  const url = `${base()}/player/${encodeURIComponent(id)}?mode=${mode}&t=${Math.round(t)}&paused=${paused ? 1 : 0}&token=${TOKEN}&chrome=0`
  await startView(id, url, width, height, { kind: 'recording', mode, paused: mode !== 'live' && paused, t, totalMs: durationOf(rec) })
}

const canvasViewId = projectId => `canvas-${safeId(projectId)}`

/**
 * Screencasts the canvas page: every journey of the project as rrweb players, as one picture.
 * One already on screen is resized in place (the pane changed shape), its players kept.
 */
async function startCanvasView(projectId, { width = CANVAS_W, height = CANVAS_H } = {}) {
  const w = Math.max(640, Math.min(2400, Math.round(Number(width) || CANVAS_W)))
  const h = Math.max(240, Math.min(1600, Math.round(Number(height) || CANVAS_H)))
  const id = canvasViewId(projectId)
  const player = players.get(id)
  const f = frames.get(id)
  if (player?.sessionId && f) {
    if (f.width === w && f.height === h) return
    await chrome.send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: false }, player.sessionId)
    await chrome.send('Page.stopScreencast', {}, player.sessionId).catch(() => {})
    await chrome.send('Page.startScreencast', { format: 'png', everyNthFrame: 1, maxWidth: w, maxHeight: h }, player.sessionId)
    Object.assign(f, { width: w, height: h, seq: (f.seq ?? 0) + 1 })
    bump(id)
    return
  }
  const url = `${base()}/canvas/${encodeURIComponent(projectId)}?embed=1&token=${TOKEN}`
  await startView(id, url, w, h, { kind: 'canvas', mode: 'canvas' })
}

/** Stops the view for `id`; with `only`, just when that one is still current. */
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
  const rec = recordings.get(id)
  if (!rec) throw new Error(`no recording ${id}`)
  const player = players.get(id)
  const f = frames.get(id)
  if (!player || player.mode === 'live' || !player.sessionId) {
    const here = f?.currentMs ?? 0
    const t = action === 'seek' ? Number(ms) || 0 : action === 'seekBy' ? here + (Number(ms) || 0) : f?.status === 'finished' ? 0 : here
    const total = durationOf(rec)
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
    if (player.kind === 'recording' && player.mode !== 'live' && Date.now() - player.touched > IDLE_PLAYER_MS) void stopPlayer(id, player)
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

const page = name => fs.readFileSync(path.join(HERE, name), 'utf8')

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://127.0.0.1')
    const parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent)

    if (parts[0] === 'vendor' && /^[a-z0-9.-]+$/.test(parts[1] ?? '')) {
      const file = path.join(HERE, 'vendor', parts[1])
      if (!fs.existsSync(file)) return send(res, 404, { error: 'not found' })
      return send(res, 200, fs.readFileSync(file), parts[1].endsWith('.css') ? 'text/css' : 'text/javascript')
    }

    const token = url.searchParams.get('token') ?? req.headers['x-replay-qa-live-token']
    if (token !== TOKEN) return send(res, 403, { error: 'bad token' })

    if (req.method === 'GET' && parts[0] === 'health') return send(res, 200, { ok: true, followed: [...followed], recordings: recordings.size, apiBase: DEFAULT_API_BASE })

    // POST /qa/follow { projectId, on, server? } -> turn running work of a project into recordings as it starts;
    // `server` (an API base, a QA URL or a dashboard URL) says which QA server the project is on
    if (req.method === 'POST' && parts[0] === 'qa' && parts[1] === 'follow') {
      const { projectId, on = true, server } = await readJson(req)
      if (!projectId) return send(res, 400, { error: 'projectId required' })
      if (server && setProjectServer(projectId, server)) projects.delete(projectId)
      if (on) { followed.add(projectId); await refreshProject(projectId) } else followed.delete(projectId)
      return send(res, 200, overview(projectId) ?? { project: null })
    }

    // GET /qa/overview?project=<id>[&refresh=1] -> the canvas data
    if (req.method === 'GET' && parts[0] === 'qa' && parts[1] === 'overview') {
      const projectId = url.searchParams.get('project')
      if (!projectId) return send(res, 400, { error: 'project required' })
      const state = projects.get(projectId)
      await refreshProject(projectId, { maxAge: url.searchParams.get('refresh') ? 0 : PROJECT_MAX_AGE_MS })
      return send(res, 200, overview(projectId))
    }

    // POST /qa/watch { projectId, kind, sourceId, title?, goal? } -> a recording of that source
    if (req.method === 'POST' && parts[0] === 'qa' && parts[1] === 'watch') {
      const { projectId, kind, sourceId, title, goal } = await readJson(req)
      if (!projectId || !SOURCE_KEY[kind] || !sourceId) return send(res, 400, { error: 'projectId, kind (task|test_run|exploration) and sourceId required' })
      const rec = await watch({ projectId, kind, sourceId, title, goal })
      return send(res, 200, { recording: describe(rec), playerUrl: playerUrl(rec.id) })
    }

    if (req.method === 'GET' && parts[0] === 'recordings' && parts.length === 1) {
      return send(res, 200, [...recordings.values()].map(describe))
    }

    if (parts[0] === 'recordings' && parts[1]) {
      const rec = recordings.get(parts[1])
      if (!rec) return send(res, 404, { error: 'no such recording' })
      rec.touched = Date.now()
      if (rec.evicted) hydrate(rec)

      if (req.method === 'GET' && parts[2] === undefined) return send(res, 200, describe(rec))
      if (req.method === 'GET' && parts[2] === 'events') {
        // `from`/`feedFrom` turn this into a cheap poll: only what was added since.
        const from = Number(url.searchParams.get('from') ?? 0) || 0
        const feedFrom = Number(url.searchParams.get('feedFrom') ?? 0) || 0
        return send(res, 200, { recording: describe(rec), from, events: rec.events.slice(from), feedFrom, feed: rec.feed.slice(feedFrom) })
      }
      if (req.method === 'GET' && parts[2] === 'rrweb.json') {
        res.writeHead(200, { 'content-type': 'application/json', 'content-disposition': `attachment; filename="${rec.id}.rrweb.json"` })
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
        else if (mode === 'live' && rec.status !== 'ended') await startPlayer(rec.id, 'live')
        else if (mode === 'replay' || mode === 'live') await startPlayer(rec.id, 'replay')
        else if (CONTROLS[mode]) await control(rec.id, mode, ms)
        else return send(res, 400, { error: `unknown player mode ${mode}` })
        return send(res, 200, framesSnapshot().frames[rec.id] ?? null)
      }
    }

    // POST /canvas/:project/view { on, width?, height? } -> screencast the canvas page for the terminal
    if (req.method === 'POST' && parts[0] === 'canvas' && parts[1] && parts[2] === 'view') {
      const { on = true, width, height } = await readJson(req)
      const id = canvasViewId(parts[1])
      if (on) await startCanvasView(parts[1], { width, height })
      else await stopPlayer(id)
      return send(res, 200, framesSnapshot().frames[id] ?? null)
    }

    // POST /canvas/:project/camera { op: zoom|pan|focus|minimap|gesture|fit|actual|state, factor?, x?, y?, dx?, dy?,
    // id?, sx?, sy?, done? } -> move the screencast canvas's camera; points and distances are fractions of the picture
    // (of the minimap for `minimap`). A `gesture` is a pointer drag as it stands, which scrubs a tile's timeline,
    // presses its buttons or pans. Answers { result: { k, minimap } }: the zoom, and where the minimap sits.
    if (req.method === 'POST' && parts[0] === 'canvas' && parts[1] && parts[2] === 'camera') {
      const player = players.get(canvasViewId(parts[1]))
      if (!player?.sessionId) return send(res, 409, { error: 'the canvas is not on screen' })
      const { op, factor, x, y, dx, dy, id: gestureId, sx, sy, done } = await readJson(req)
      const n = (v, lo, hi, fallback) => (Number.isFinite(v) ? Math.max(lo, Math.min(hi, v)) : fallback)
      const args = {
        zoom: [n(factor, 0.1, 10, 1), n(x, 0, 1, 0.5), n(y, 0, 1, 0.5)],
        pan: [n(dx, -10, 10, 0), n(dy, -10, 10, 0)],
        focus: [n(x, 0, 1, 0.5), n(y, 0, 1, 0.5)],
        minimap: [n(x, 0, 1, 0.5), n(y, 0, 1, 0.5)],
        gesture: [Math.trunc(n(gestureId, 0, 1e9, 0)), n(sx, -2, 3, 0.5), n(sy, -2, 3, 0.5), n(x, -2, 3, 0.5), n(y, -2, 3, 0.5), done === true],
        state: [],
        fit: [],
        actual: [],
      }[op]
      if (!args) return send(res, 400, { error: `unknown camera op ${op}` })
      player.touched = Date.now()
      const result = await evaluate(player.sessionId, `window.__canvas ? window.__canvas.${op}(${args.map(a => JSON.stringify(a)).join(', ')}) : null`)
      return send(res, 200, { result })
    }

    // GET /player/:id and /canvas/:project -> the pages the screencast (or a person) loads
    if (req.method === 'GET' && parts[0] === 'player' && parts[1]) return send(res, 200, page('player.html'), 'text/html; charset=utf-8')
    if (req.method === 'GET' && parts[0] === 'canvas' && parts[1]) return send(res, 200, page('canvas.html'), 'text/html; charset=utf-8')

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
    log('request failed', err.stack ?? err)
    if (!res.headersSent) send(res, err instanceof AuthError ? 401 : err instanceof NotFoundError ? 404 : 500, { error: String(err.message ?? err) })
  }
})

const base = () => `http://127.0.0.1:${server.address().port}`
function playerUrl(id) { return `${base()}/player/${encodeURIComponent(id)}?mode=auto&chrome=1&token=${TOKEN}` }
function canvasUrl(projectId) { return `${base()}/canvas/${encodeURIComponent(projectId)}?token=${TOKEN}` }

server.listen(Number(process.env.REPLAY_QA_LIVE_PORT ?? 0), '127.0.0.1', () => {
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
