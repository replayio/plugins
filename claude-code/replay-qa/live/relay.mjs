#!/usr/bin/env node
// Local relay for the replay-qa plugin's live views (hooks/register.tsx).
//
// - Reads Replay QA recordings from the QA API (recording-events), live while an exploration
//   or journey test run executes and from the saved stream afterwards, and keeps each one as
//   rrweb events in memory and as NDJSON on disk.
// - Follows a project: any exploration, test run or task that is running gets a recording
//   automatically, so every live journey streams in parallel.
// - Shows the dashboard /p/ pages and inline recordings as browser screencasts.
// - Holds what the session's folder is about (`replayqa detect`, told by the hooks module) for the
//   browser view of it, and runs the `replayqa run` tunnels the person starts from it.
// - Holds the Replay QA MCP sign-in in memory: a credential the hooks module minted is exchanged here, its
//   token refreshed for as long as the session lasts, and each process it runs gets a credential minted on it.
//
// Zero dependencies: Node >= 22 (global fetch + WebSocket).
// Prints one JSON line on stdout once listening: { port, token, dataDir, hookToken }.

import { createFramePump } from './frame-pump.mjs'
import { dispatchDashboardInput } from './dashboard-input.mjs'
import http from 'node:http'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'
import net from 'node:net'
import { execFile, execFileSync, spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

import { decodeCredential, exchangeCredential, mintWithToken, newPkcePair, refreshSession } from './mcp-auth.mjs'
import { AuthError, NotFoundError, apiBaseOf, tunnelServers } from './qa-stream.mjs'

/** live/: this script, the pages and vendor/. */
const HERE = path.dirname(fileURLToPath(import.meta.url))
const DATA_DIR = process.env.REPLAY_QA_LIVE_DIR || path.join(os.homedir(), '.claude', 'replay-qa-live')
const REC_DIR = path.join(DATA_DIR, 'recordings')
const FRAME_DIR = path.join(DATA_DIR, 'frames')
const TOKEN = process.env.REPLAY_QA_LIVE_TOKEN || crypto.randomUUID()
/** What only the hooks module may do (a credential, starting a tunnel) takes this, in a header: pages have `TOKEN` in their URL. */
const HOOK_TOKEN = crypto.randomUUID()
const SERVERS_FILE = path.join(DATA_DIR, 'servers.json')
const PLAYER_W = 1280
const PLAYER_H = 800
const CANVAS_W = 1600
const CANVAS_H = 900
const MAX_FPS = 12
const DASHBOARD_FPS = 30
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
/** A QA token or credential in a line of output never leaves the relay. */
const scrub = text => String(text).replace(/\b(mcl|mcp|mcr|lqa)_[A-Za-z0-9._~+/=-]{4,}/g, '$1_***')
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

/**
 * How a QA server is named to a person: its host, and, for a PR's preview, what that means. A preview
 * goes away with its PR, and a project made there stays mapped to it in servers.json.
 */
function serverNote(apiBase) {
  const host = new URL(apiBase).host
  const pr = /^(?:pr|deploy-preview)-(\d+)--/.exec(host)?.[1]
  return { host, previewNote: pr ? ` That server is the preview of PR #${pr}, which may have been merged or closed.` : '' }
}

/**
 * What always works, whatever the MCP server can do: a sign-in through it reaches the relay only where it
 * offers `create_cli_credential`, so saying /mcp here would leave someone already signed in there stuck.
 */
const HOW_TO_SIGN_IN = 'run `npx --yes replayqa@0.7.0 login`, or set REPLAY_QA_API_KEY'

/** The existing sign-ins: REPLAY_QA_API_KEY and its older names, then `replayqa login` (or `replayio login`, the same cache). */
function existingToken() {
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
  throw new AuthError(`No Replay QA sign-in: ${HOW_TO_SIGN_IN}`)
}

/**
 * QA server origin -> what the Replay QA MCP sign-in gave for it: tokens, in memory only, never logged.
 * A token goes to the server that issued it and no other.
 */
const mcpSessions = new Map()
const REFRESH_MARGIN_MS = 2 * 60_000

/** The verifier for the credential the hooks module is asking for. One at a time: it signs the relay in once. */
let pendingPkce = null

/** Exchanges a credential the hooks module minted; it is single-use, so the session it gives is kept. */
async function adoptCredential(credential) {
  const verifier = pendingPkce?.challenge === decodeCredential(credential).challenge ? pendingPkce.verifier : undefined
  pendingPkce = null
  if (!verifier) throw new Error('The relay did not ask for that Replay QA CLI credential.')
  const session = await exchangeCredential(credential, verifier)
  mcpSessions.set(session.origin, { ...session, refreshing: null })
  return session
}

/** The MCP sign-in's access token for a server, refreshed as it nears its end; null when it has none. */
async function mcpToken(origin, { force = false } = {}) {
  const session = mcpSessions.get(origin)
  if (!session) return null
  if (!force && Date.now() < session.expiresAt - REFRESH_MARGIN_MS) return session.accessToken
  // One at a time: refresh tokens rotate, so a second use of the same one would be refused.
  session.refreshing ??= refreshSession(session)
    .then(fresh => { Object.assign(session, fresh) })
    .catch(err => {
      log(`the MCP token could not be refreshed (${err.status ?? 'no answer'})`)
      if (err.status >= 400 && err.status < 500) mcpSessions.delete(origin)
    })
    .finally(() => { session.refreshing = null })
  await session.refreshing
  return mcpSessions.has(origin) && Date.now() < session.expiresAt ? session.accessToken : null
}

/** A single-use credential for one process, on the relay's own MCP sign-in; null with none, or from a server that gives none. */
async function mintCredential() {
  const session = [...mcpSessions.values()].at(-1)
  if (!session) return null
  const { origin } = session
  try {
    const token = await mcpToken(origin)
    return token && (await mintWithToken(origin, token))
  } catch (err) {
    if (err.status !== 401) {
      log(`a credential could not be minted (${err.status ?? 'no answer'})`)
      return null
    }
    const fresh = await mcpToken(origin, { force: true })
    return fresh ? mintWithToken(origin, fresh).catch(() => null) : null
  }
}

/** The token for a server: the MCP sign-in when there is one for it, else the existing sign-ins. */
async function authToken(apiBase) {
  return (await mcpToken(new URL(apiBase).origin)) ?? existingToken()
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
    const send = async token => fetch(`${apiBase}${apiPath}`, {
      method,
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(60_000),
    })
    let res = await send(await authToken(apiBase))
    // A token the server has stopped taking gets one fresh try before the existing sign-ins answer for it.
    const origin = new URL(apiBase).origin
    if (res.status === 401 && mcpSessions.has(origin)) {
      res = await send((await mcpToken(origin, { force: true })) ?? existingToken())
    }
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
      if (!bin) return reject(new Error('No browser found for the inline player: install Replay Chromium (npx @replayio/replay@0.22.12 install) or set REPLAY_LIVE_CHROME'))
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
const SOURCE_FLAG = { task: 'task', test_run: 'test-run', exploration: 'exploration' }

/** project id -> { project, journeys, runs, explorations, liveTasks, updatedAt, error, refreshing } */
const projects = new Map()
/** project ids whose running work is turned into recordings automatically. */
const followed = new Set()

const itemsOf = data => (Array.isArray(data) ? data : data?.items ?? [])

async function refreshProject(projectId, { maxAge = 0 } = {}) {
  let state = projects.get(projectId)
  if (!state) projects.set(projectId, (state = { project: null, journeys: [], runs: [], explorations: [], liveTasks: [], updatedAt: 0, error: null, authRequired: false, refreshing: null }))
  if (state.refreshing) return state.refreshing
  if (maxAge && Date.now() - state.updatedAt < maxAge) return state
  state.refreshing = (async () => {
    const apiBase = await apiBaseFor(projectId)
    const { host, previewNote } = serverNote(apiBase)
    // Known before anything can fail: what the person needs to see is which server it was.
    state.server = apiBase
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
        if (r.status === 401) throw new AuthError(`Replay QA on ${host} answered ${r.status} for project ${projectId}: ${HOW_TO_SIGN_IN}.${previewNote}`)
        if (r.status === 403) throw new Error(`Replay QA on ${host} denied access to project ${projectId}. Check that this account is a project member.${previewNote}`)
        if (r.status === 404) throw new NotFoundError(`No Replay QA project ${projectId} on ${host}: for a PR preview or staging, open the canvas with its dashboard URL.${previewNote}`)
        if (r.status !== 200) throw new Error(`Replay QA on ${host} answered ${r.status} for project ${projectId}.${previewNote}`)
      }
      const p = project.data
      state.project = { id: p.id, name: p.name, target_url: p.target_url, status: p.status }
      state.journeys = itemsOf(journeys.data)
      state.runs = itemsOf(runs.data)
      state.explorations = explorations.status === 200 ? itemsOf(explorations.data) : []
      state.liveTasks = [...itemsOf(running.data), ...itemsOf(queued.data)]
      state.error = null
      state.authRequired = false
      state.updatedAt = Date.now()
    } catch (err) {
      state.authRequired = err instanceof AuthError
      state.error = err instanceof AuthError || err instanceof NotFoundError || /Replay QA on /.test(err.message)
        ? err.message
        : `Could not reach Replay QA on ${host} for project ${projectId}: ${err.message}.${previewNote}`
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
    project: state.project, server: state.server && state.server !== DEFAULT_API_BASE ? state.server : null, error: state.error, authRequired: state.authRequired, updatedAt: state.updatedAt, following: followed.has(projectId),
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

/** The pinned CLI that reads recordings. A release cannot change this plugin's stream by itself. */
const REPLAYQA = process.env.REPLAY_QA_CLI?.split(' ').filter(Boolean) ?? ['npx', '--yes', 'replayqa@0.7.0']
/** Readers running now, so none outlives the relay. */
const readers = new Set()
/** A reader refused sooner than this was not refused because its token ran out. */
const READER_MIN_LIFE_MS = Number(process.env.REPLAY_QA_READER_MIN_LIFE_MS ?? 60_000)

/** A reader started again reads from the top: each task's rows already applied are skipped by their sequence number. */
function isNewRow(rec, row) {
  if (typeof row.seq !== 'number' || typeof row.task_id !== 'string') return true
  rec.lastSeq ??= new Map()
  if (row.seq <= (rec.lastSeq.get(row.task_id) ?? -1)) return false
  rec.lastSeq.set(row.task_id, row.seq)
  return true
}

/**
 * Runs `replayqa recording-events` for a recording, applying each batch of rows as it arrives.
 * `stop()` ends a `--forever` reader; `done` resolves when it has exited, or rejects with why it failed.
 */
async function readRows(rec, flags) {
  const [command, ...args] = REPLAYQA
  const apiBase = await apiBaseFor(rec.projectId)
  // The pinned CLI takes a token as it is, so a reader runs on the MCP sign-in's current one when there
  // is one for its server, and on the existing sign-ins when there is not. readLoop starts it again if
  // the token runs out under it.
  const signIn = await mcpToken(new URL(apiBase).origin)
  const child = spawn(command, [
    ...args, 'recording-events', '--project-id', rec.projectId, `--${SOURCE_FLAG[rec.kind]}`, rec.sourceId, '--ignore-config', ...flags,
  ], { stdio: ['pipe', 'pipe', 'pipe'], detached: true, env: { ...process.env, REPLAY_QA_API_BASE: apiBase, ...(signIn ? { REPLAY_QA_API_KEY: signIn } : {}) } })
  const stop = () => {
    // npx runs the CLI as its own child: signal the group. Closing stdin ends it even if this never runs.
    try { process.kill(-child.pid, 'SIGTERM') } catch {}
    child.stdin.destroy()
  }
  readers.add(stop)
  let buffered = ''
  let stderr = ''
  child.stdout.setEncoding('utf8')
  child.stdout.on('data', chunk => {
    buffered += chunk
    const lines = buffered.split('\n')
    buffered = lines.pop()
    const rows = []
    for (const line of lines) {
      try {
        const row = JSON.parse(line)
        if ((row.kind === 'rrweb' || row.kind === 'note') && isNewRow(rec, row)) rows.push(row)
      } catch {}
    }
    if (rows.length === 0) return
    rec.loadedPages++
    applyRows(rec, rows)
    bump(rec.id)
  })
  child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-2000) })
  const done = new Promise((resolve, reject) => {
    child.on('error', err => reject(new Error(`could not run ${command}: ${err.message}`)))
    child.on('close', (code, signal) => {
      readers.delete(stop)
      if (code === 0 || signal) return resolve()
      const message = stderr.trim() || `replayqa recording-events exited ${code}`
      reject(code === 2 ? new AuthError(message) : code === 3 ? new NotFoundError(message) : new Error(message))
    })
  })
  return { stop, done }
}

async function readLoop(rec) {
  try {
    await refreshProject(rec.projectId, { maxAge: PROJECT_MAX_AGE_MS }).catch(() => {})
    if (sourceIsLive(rec.projectId, rec.kind, rec.sourceId)) {
      rec.status = 'live'
      bump(rec.id)
      let reader = await readRows(rec, ['--forever', '--interval-ms', String(LIVE_POLL_MS)])
      let startedAt = Date.now()
      let failed = null
      reader.done.catch(err => { failed = err })
      for (;;) {
        await sleep(LIVE_POLL_MS)
        if (failed) {
          // An MCP token lasts an hour and the reader holds one: a reader that ran a while gets a fresh one.
          const origin = new URL(await apiBaseFor(rec.projectId)).origin
          const canRenew = failed instanceof AuthError && Date.now() - startedAt > READER_MIN_LIFE_MS && (await mcpToken(origin, { force: true }))
          if (!canRenew) throw failed
          failed = null
          reader = await readRows(rec, ['--forever', '--interval-ms', String(LIVE_POLL_MS)])
          startedAt = Date.now()
          reader.done.catch(err => { failed = err })
          continue
        }
        await refreshProject(rec.projectId, { maxAge: PROJECT_MAX_AGE_MS }).catch(() => {})
        if (!sourceIsLive(rec.projectId, rec.kind, rec.sourceId)) break
      }
      // Rows can land just after the status flips: the reader gets a poll or two more.
      await sleep(LIVE_POLL_MS + 1_500)
      reader.stop()
      await reader.done
    } else {
      // Finished: a one-shot read. These load on demand, so at most a few at once.
      await slot()
      try {
        const reader = await readRows(rec, [])
        await reader.done
      } finally {
        release()
      }
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

/** view id -> { targetId, sessionId, kind, mode, touched, framePump } */
const players = new Map()
const MAX_PLAYERS = 4
const IDLE_PLAYER_MS = 10 * 60_000

/** A renderer tab sized to `width` x `height`, its `__playerEvent` binding delivered to `onEvent`. */
async function openTarget(url, width, height, onEvent) {
  await chrome.start()
  const { targetId } = await chrome.send('Target.createTarget', { url: 'about:blank' })
  const { sessionId } = await chrome.send('Target.attachToTarget', { targetId, flatten: true })
  const origin = new URL(url).origin
  const dashboard = new URL(url).pathname.startsWith('/p/')
  chrome.handlers.set(sessionId, (method, params) => {
    if (dashboard && method === 'Fetch.requestPaused') {
      void (async () => {
        const request = new URL(params.request.url)
        const token = request.origin === origin && request.pathname.startsWith('/api/')
          ? await authToken(`${origin}/api/v1`).catch(err => { if (err instanceof AuthError) return null; throw err }) : null
        const headers = Object.entries(params.request.headers).filter(([name]) => !token || name.toLowerCase() !== 'authorization')
          .map(([name, value]) => ({ name, value: String(value) }))
        if (token) headers.push({ name: 'Authorization', value: `Bearer ${token}` })
        await chrome.send('Fetch.continueRequest', { requestId: params.requestId, headers }, sessionId)
      })().catch(() => chrome.send('Fetch.failRequest', { requestId: params.requestId, errorReason: 'Failed' }, sessionId).catch(() => {}))
      return
    }
    onEvent(method, params)
  })
  if (dashboard) await chrome.send('Fetch.enable', { patterns: [{ urlPattern: `${origin}/api/*`, requestStage: 'Request' }] }, sessionId)
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
  const player = { kind, mode, touched: Date.now(), framePump: null }
  players.set(id, player)

  player.framePump = createFramePump({
    fps: kind === 'canvas' ? DASHBOARD_FPS : MAX_FPS,
    write: async (data, isCurrent) => {
      const tmp = `${frameFile}.${process.pid}.tmp`
      await fsp.writeFile(tmp, Buffer.from(data, 'base64'))
      if (!isCurrent()) { await fsp.rm(tmp, { force: true }); return }
      await fsp.rename(tmp, frameFile)
      const f = frames.get(id)
      if (f && isCurrent()) { f.generation += 1; bump(id) }
    },
    onError: err => log('frame write failed', err.message),
  })

  const target = await openTarget(url, width, height, (method, params) => {
    if (method === 'Page.screencastFrame') {
      chrome.send('Page.screencastFrameAck', { sessionId: params.sessionId }, player.sessionId).catch(() => {})
      player.framePump.push(params.data)
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
 * Screencasts the dashboard's embedded project page.
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
  const url = await dashboardUrl(projectId)
  await startView(id, url, w, h, { kind: 'canvas', mode: 'canvas' })
}

async function stopPlayer(id, only) {
  const player = players.get(id)
  if (!player || (only && player !== only)) return
  players.delete(id)
  await player.framePump?.close()
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

// ------------------------------------------------------------------- the folder
// What the session's folder is about, as `replayqa detect` said: the hooks module tells it, the browser
// view reads it. A press in the browser view is queued for the hooks module, which alone can mint a credential.

/** { view: 'index'|'setup', folder: the detection, or null when it did not run, why: why not, error: what a press last ran into, signIn: how the person is signed in, in words } */
let folderState = { view: null, folder: null, why: null, error: null, signIn: null }
const folderActions = []
/** project id -> { name, status, error, at }: enough to name a project in the index. */
const summaries = new Map()
const SUMMARY_MAX_AGE_MS = 30_000

async function summarize(entry) {
  const known = summaries.get(entry.project_id)
  if (known && Date.now() - known.at < SUMMARY_MAX_AGE_MS) return
  // A project on a server only its repo's config names is read when it is opened, not to list it.
  if (entry.qa_url && !projectServers.has(entry.project_id)) return
  summaries.set(entry.project_id, { ...known, at: Date.now() })
  const apiBase = await apiBaseFor(entry.project_id)
  const { host, previewNote } = serverNote(apiBase)
  try {
    const { status, data } = await request(`/projects/${encodeURIComponent(entry.project_id)}`)
    summaries.set(entry.project_id, status === 200
      ? { name: data.name ?? null, status: data.status ?? null, error: null, server: apiBase === DEFAULT_API_BASE ? null : host, at: Date.now() }
      : { name: known?.name ?? null, status: null, error: `Replay QA on ${host} answered ${status}.${previewNote}`, server: apiBase === DEFAULT_API_BASE ? null : host, at: Date.now() })
  } catch (err) {
    summaries.set(entry.project_id, { name: known?.name ?? null, status: null, error: err instanceof AuthError ? err.message : `Could not reach Replay QA on ${host}.${previewNote}`, server: apiBase === DEFAULT_API_BASE ? null : host, at: Date.now() })
  }
}

function authStatus() {
  let existing = false
  try { existing = Boolean(existingToken()) } catch {}
  return {
    mcp: [...mcpSessions.values()].filter(s => Date.now() < s.expiresAt).map(s => ({ origin: s.origin, expiresAt: s.expiresAt })),
    existing,
  }
}

const isPortOpen = port => new Promise(resolve => {
  const socket = net.createConnection({ host: 'localhost', port })
  const finish = open => { socket.destroy(); resolve(open) }
  socket.setTimeout(800)
  socket.once('connect', () => finish(true))
  socket.once('error', () => finish(false))
  socket.once('timeout', () => finish(false))
})

// -------------------------------------------------------------------- tunnels
// `replayqa run` starts the app and its tunnel as one process, which has to stay up for the whole test.
// It runs here because the relay outlives any press and already exits when Claude Code goes away, taking
// its process groups with it. A credential reaches it in the environment, never in its arguments.

/** key (the app's path) -> the run */
const tunnelRuns = new Map()

const TUNNEL_TEXT = {
  preparing: 'Starting replayqa…',
  'starting-app': 'Starting the app…',
  'app-ready': 'The app answered. Setting up the project…',
  connecting: 'Connecting the tunnel…',
  waiting: 'Waiting for the tunnel…',
  ready: 'Tunnel ready: Replay QA can reach the app.',
  stopping: 'Stopping…',
  stopped: 'Stopped.',
  failed: 'It stopped with an error.',
}

function describeTunnel(t) {
  return {
    key: t.key, label: t.label, targetUrl: t.targetUrl, status: t.status, text: t.waitingText ?? TUNNEL_TEXT[t.status],
    isRunning: !t.exitedAt, projectId: t.projectId, qaUrl: t.qaUrl, error: t.error, note: t.note, tail: t.tail.slice(-4),
    startedAt: t.startedAt, exitedAt: t.exitedAt,
  }
}
const listTunnels = () => [...tunnelRuns.values()].map(describeTunnel)

function setTunnel(t, fields) {
  Object.assign(t, { waitingText: null }, fields)
  bump()
}

/** One line of `replayqa run --json`: an event of its own, a line of its own, or the app's output. */
function readTunnelLine(t, raw) {
  const line = scrub(raw).trimEnd()
  // replayqa prints a failure with its stack: the frames say nothing to a person.
  if (!line || /^\s+at\s/.test(line)) return
  const project = /(?:Created|Using) Replay QA project (proj[-_][\w-]+)/.exec(line)?.[1]
  if (project) {
    if (t.qaUrl) setProjectServer(project, t.qaUrl)
    return setTunnel(t, { projectId: project, status: 'connecting' })
  }
  if (/^Starting local app:/.test(line)) return setTunnel(t, { status: 'starting-app' })
  if (/^Local app is reachable at/.test(line)) return setTunnel(t, { status: 'app-ready' })
  let event = null
  if (line.startsWith('{')) {
    try { event = JSON.parse(line) } catch {}
  }
  if (typeof event?.event !== 'string') {
    t.tail.push(line.slice(0, 300))
    if (t.tail.length > 40) t.tail.shift()
    return
  }
  if (event.event === 'heartbeat') {
    if (event.ready) return setTunnel(t, { status: 'ready', error: null })
    return setTunnel(t, { status: 'waiting', waitingText: `Waiting: tunnel ${event.frpcConnected ? 'connected' : 'not connected'}, app ${event.targetReachable ? 'reachable' : 'not reachable'}.` })
  }
  if (event.event === 'heartbeat-error') return setTunnel(t, { error: scrub(event.error ?? 'A heartbeat failed.') })
  if (event.event === 'host-blocked') return setTunnel(t, { note: `Blocked ${scrub(event.host)}: start it by hand with --allow ${scrub(event.host)} if the app needs this computer's network for it.` })
  if (t.status !== 'ready' && ['starting', 'tunnel-status', 'dns-waiting', 'dns-ready', 'forward-proxy-listening', 'frpc-starting'].includes(event.event)) setTunnel(t, { status: 'connecting' })
}

/** What a failed run last said was wrong: its last error line, else its last line of any kind. */
function failureOf(tail) {
  const line = tail.findLast(text => /^(?:\w*Error:|error:|npm error)/.test(text)) ?? tail.at(-1)
  return line?.replace(/^(?:\w*Error:|error:)\s*/, '') ?? null
}

function readLines(stream, onLine) {
  let pending = ''
  stream.setEncoding('utf8')
  stream.on('data', chunk => {
    pending += chunk
    const lines = pending.split(/\r?\n/)
    pending = lines.pop()
    for (const line of lines) onLine(line)
  })
  stream.on('end', () => { if (pending) onLine(pending) })
}

async function runTunnel(t, { args, cwd, env }) {
  const childEnv = { ...process.env, ...env }
  for (const name of ['REPLAY_QA_LIVE_TOKEN', 'REPLAY_QA_LIVE_PORT', 'REPLAY_QA_LIVE_DIR']) delete childEnv[name]
  const childArgs = [...args, '--json']
  // One credential per process. replayqa takes it out of its environment at startup, so the app does not
  // inherit it, exchanges it and refreshes in memory, so the tunnel outlives the hour-long token. With no
  // MCP sign-in, replayqa uses its own: REPLAY_QA_API_KEY, then `replayqa login`.
  const credential = await mintCredential()
  if (credential) {
    const { origin } = decodeCredential(credential)
    childEnv.REPLAY_QA_API_KEY = credential
    // The server that issued it, whatever the environment or a config in the folder names.
    delete childEnv.REPLAY_QA_API_BASE
    childEnv.REPLAY_QA_URL = origin
    t.qaUrl = origin
    childArgs.push('--qa-url', origin)
  }
  if (t.stopping) return setTunnel(t, { status: 'stopped', exitedAt: Date.now() })
  const child = spawn(REPLAYQA[0], [...REPLAYQA.slice(1), ...childArgs], { cwd, env: childEnv, stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32' })
  t.child = child
  readLines(child.stdout, line => readTunnelLine(t, line))
  readLines(child.stderr, line => readTunnelLine(t, line))
  child.once('error', err => { t.spawnError = err.message })
  // What it left behind may hold its pipes: its exit is its end, a moment later at most.
  child.once('exit', () => {
    const release = setTimeout(() => { child.stdout.destroy(); child.stderr.destroy() }, 3_000)
    release.unref()
  })
  child.once('close', code => {
    for (const timer of t.killTimers) clearTimeout(timer)
    const failed = !t.stopping && code !== 0
    setTunnel(t, {
      child: null,
      exitedAt: Date.now(),
      status: failed ? 'failed' : 'stopped',
      error: failed ? (t.spawnError ?? failureOf(t.tail) ?? `replayqa exited with ${code}.`) : t.error,
    })
  })
  bump()
}

function startTunnel({ key, label, args, cwd, env = {}, targetUrl }) {
  const running = tunnelRuns.get(key)
  if (running && !running.exitedAt) return running
  const t = {
    key, label: label ?? key, targetUrl: targetUrl ?? null, status: 'preparing', waitingText: null, projectId: null, qaUrl: null,
    error: null, note: null, tail: [], startedAt: Date.now(), exitedAt: null, child: null, stopping: false, killTimers: [], spawnError: null,
  }
  tunnelRuns.set(key, t)
  runTunnel(t, { args, cwd, env }).catch(err => {
    setTunnel(t, { status: 'failed', error: scrub(err.message), exitedAt: Date.now() })
  })
  bump()
  return t
}

/**
 * A run's processes, the root last. replayqa starts the app in a process group of its own and stops it
 * itself only once the tunnel is up; a signal before then would leave the app running on its port, and
 * holding the pipes of a run that has otherwise ended.
 */
function processTree(rootPid) {
  const children = new Map()
  try {
    for (const line of execFileSync('ps', ['-axo', 'pid=,ppid='], { encoding: 'utf8', timeout: 3_000 }).split('\n')) {
      const [pid, ppid] = line.trim().split(/\s+/).map(Number)
      if (pid && ppid) children.set(ppid, [...(children.get(ppid) ?? []), pid])
    }
  } catch {}
  const tree = []
  const visit = pid => {
    for (const child of children.get(pid) ?? []) visit(child)
    tree.push(pid)
  }
  visit(rootPid)
  return tree
}

function signalAll(pids, signal) {
  for (const pid of pids) {
    try { process.kill(pid, signal) } catch {}
  }
}

/** Asks a run to stop: replayqa first, as it stops what it started; after a moment whatever is left, by name. */
function stopTunnel(t) {
  if (t.exitedAt) return
  t.stopping = true
  if (!t.child?.pid) return bump()
  setTunnel(t, { status: 'stopping' })
  const family = processTree(t.child.pid)
  signalAll([process.platform === 'win32' ? t.child.pid : -t.child.pid], 'SIGTERM')
  t.killTimers = [
    setTimeout(() => signalAll(family, 'SIGTERM'), 3_000),
    setTimeout(() => signalAll(family, 'SIGKILL'), 12_000),
  ]
  for (const timer of t.killTimers) timer.unref()
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

    // What only the hooks module may do.
    const isHookRoute = (parts[0] === 'auth' && (parts[1] === 'challenge' || parts[1] === 'credential' || parts[1] === 'mint'))
      || (parts[0] === 'tunnels' && req.method === 'POST')
      || (parts[0] === 'qa' && parts[1] === 'folder' && !parts[2] && req.method === 'POST')
    if (isHookRoute && req.headers['x-replay-qa-hook-token'] !== HOOK_TOKEN) return send(res, 403, { error: 'bad token' })

    // POST /auth/challenge -> the hash to ask the MCP server for a credential with; what it hashes stays here
    if (req.method === 'POST' && parts[0] === 'auth' && parts[1] === 'challenge') {
      pendingPkce = newPkcePair()
      return send(res, 200, { code_challenge: pendingPkce.challenge })
    }

    // POST /auth/credential { credential } -> exchanges it and keeps the tokens in memory; answers no secret
    if (req.method === 'POST' && parts[0] === 'auth' && parts[1] === 'credential') {
      const { credential } = await readJson(req)
      try {
        const session = await adoptCredential(credential)
        return send(res, 200, { origin: session.origin, expiresAt: session.expiresAt })
      } catch (err) {
        return send(res, 400, { error: scrub(err.message) })
      }
    }

    // POST /auth/mint -> a single-use credential for one process the hooks module runs; null with no MCP sign-in
    if (req.method === 'POST' && parts[0] === 'auth' && parts[1] === 'mint') {
      const credential = await mintCredential()
      return send(res, 200, { credential: credential ?? null, qaUrl: credential ? decodeCredential(credential).origin : null })
    }

    // GET /auth/status -> which sign-ins there are; never a token
    if (req.method === 'GET' && parts[0] === 'auth' && parts[1] === 'status') return send(res, 200, authStatus())

    // POST /qa/folder { view, folder, why, error, signIn } -> what `replayqa detect` said about the session's folder
    if (req.method === 'POST' && parts[0] === 'qa' && parts[1] === 'folder' && !parts[2]) {
      const { view = null, folder = null, why = null, error = null, signIn = null } = await readJson(req)
      folderState = { view, folder, why, error, signIn }
      return send(res, 200, { ok: true })
    }

    // GET /qa/folder -> what the browser view of the folder draws
    if (req.method === 'GET' && parts[0] === 'qa' && parts[1] === 'folder' && !parts[2]) {
      for (const entry of folderState.folder?.projects ?? []) void summarize(entry).catch(err => log('summary failed', err.message))
      return send(res, 200, { ...folderState, summaries: Object.fromEntries(summaries), tunnels: listTunnels(), auth: authStatus() })
    }

    // POST /qa/folder/action { type, ... } -> a press in the browser view, for the hooks module to act on and check
    if (req.method === 'POST' && parts[0] === 'qa' && parts[1] === 'folder' && parts[2] === 'action') {
      const action = await readJson(req)
      if (typeof action?.type !== 'string') return send(res, 400, { error: 'type required' })
      folderActions.push(action)
      bump()
      return send(res, 200, { queued: true })
    }

    // GET /ports/:port -> whether something already listens there
    if (req.method === 'GET' && parts[0] === 'ports' && /^\d{2,5}$/.test(parts[1] ?? '')) {
      return send(res, 200, { port: Number(parts[1]), isOpen: await isPortOpen(Number(parts[1])) })
    }

    // POST /tunnels { key, label, args, cwd, env?, targetUrl? } -> starts `replayqa run`, once per key
    if (req.method === 'POST' && parts[0] === 'tunnels' && !parts[1]) {
      const spec = await readJson(req)
      if (!spec.key || !Array.isArray(spec.args) || !spec.cwd) return send(res, 400, { error: 'key, args and cwd required' })
      return send(res, 200, describeTunnel(startTunnel(spec)))
    }

    // POST /tunnels/:key/stop -> stops one and what it started
    if (req.method === 'POST' && parts[0] === 'tunnels' && parts[1] && parts[2] === 'stop') {
      const t = tunnelRuns.get(parts[1])
      if (!t) return send(res, 404, { error: 'no such tunnel' })
      stopTunnel(t)
      return send(res, 200, describeTunnel(t))
    }

    // GET /tunnels -> every run this session started
    if (req.method === 'GET' && parts[0] === 'tunnels' && !parts[1]) return send(res, 200, listTunnels())

    if (req.method === 'GET' && parts[0] === 'folder' && !parts[1]) return send(res, 200, page('folder.html'), 'text/html; charset=utf-8')

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

    // POST /canvas/:project/view { on, width?, height? } -> show or resize the dashboard
    if (req.method === 'POST' && parts[0] === 'canvas' && parts[1] && parts[2] === 'view') {
      const { on = true, width, height } = await readJson(req)
      const id = canvasViewId(parts[1])
      if (on) await startCanvasView(parts[1], { width, height })
      else await stopPlayer(id)
      return send(res, 200, framesSnapshot().frames[id] ?? null)
    }

    // Forward input to the real dashboard browser, using its current viewport.
    if (req.method === 'POST' && parts[0] === 'canvas' && parts[1] && parts[2] === 'input') {
      const id = canvasViewId(parts[1])
      const player = players.get(id)
      const frame = frames.get(id)
      if (!player?.sessionId || !frame) return send(res, 409, { error: 'the dashboard is not on screen' })
      const input = await readJson(req)
      await dispatchDashboardInput((method, params) => chrome.send(method, params, player.sessionId), frame, input, player.inputStreams ??= new Map())
      player.touched = Date.now()
      return send(res, 200, { ok: true })
    }

    // GET /player/:id and /canvas/:project -> the pages the screencast (or a person) loads
    if (req.method === 'GET' && parts[0] === 'player' && parts[1]) return send(res, 200, page('player.html'), 'text/html; charset=utf-8')
    if (req.method === 'GET' && parts[0] === 'canvas' && parts[1]) {
      res.writeHead(302, { location: await dashboardUrl(parts[1]) })
      return res.end()
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
      // The tunnels and the browser view's presses ride along: the hooks module is what follows this feed.
      return send(res, 200, { ...framesSnapshot(), tunnels: listTunnels(), actions: folderActions.splice(0) })
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
  process.stdout.write(JSON.stringify({ port: server.address().port, token: TOKEN, dataDir: DATA_DIR, hookToken: HOOK_TOKEN }) + '\n')
})

const shutdown = () => {
  for (const stop of readers) stop()
  chrome.stop()
  // A tunnel ends with the session, and what it started with it.
  for (const t of tunnelRuns.values()) {
    if (t.child?.pid && !t.exitedAt) signalAll(processTree(t.child.pid), 'SIGTERM')
  }
  process.exit(0)
}
process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)
process.on('SIGHUP', shutdown)
// The mod's spawn kills us when it lets go; if Claude Code itself dies we are
// reparented, so exit rather than linger with a headless Chrome.
const parent = process.ppid
setInterval(() => { if (process.ppid !== parent) shutdown() }, 5_000).unref()

async function dashboardUrl(projectId) {
  return `${new URL(await apiBaseFor(projectId)).origin}/p/${encodeURIComponent(projectId)}/overview`
}
