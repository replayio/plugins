/* @jsx h */
import type { EngineInterface, Register } from 'claude-code'

import { isRunningStatus, parseQaCommand, parseQaOutput, type QaCommand } from './detect.ts'

// Live Replay QA in the transcript. When Claude starts an exploration, or a bug marked fixed makes
// the backend re-test a journey, the relay (live/relay.mjs) reads that run's rrweb stream from the
// QA API as it happens, and a headless renderer plays it into PNG frames this module draws as an
// Image on the call's own row, scrubbable once it ends. `/replayqa canvas` opens a pane holding
// every journey of the project as rrweb players, the running ones streaming in parallel.

type Relay = { port: number; token: string; dataDir: string }

type RecordingInfo = {
  id: string
  kind: 'task' | 'test_run' | 'exploration'
  projectId: string
  sourceId: string
  title: string
  status: 'loading' | 'live' | 'ended' | 'error'
  error: string | null
  url: string | null
  eventCount: number
  durationMs: number
  note: { text: string; type: string; step: { index: number; action: string } | null } | null
  lastError: string | null
}

type FrameInfo = {
  file: string
  generation: number
  width: number
  height: number
  kind: 'recording' | 'canvas'
  mode: 'live' | 'replay' | 'canvas'
  status: 'playing' | 'paused' | 'finished' | 'stopped'
  currentMs: number
  totalMs: number
  /** When `currentMs` was true, on the relay's clock (the same machine's). */
  at: number
  /** Bumped by every seek, play and pause. */
  seq: number
  recording: RecordingInfo | null
}

type Tile = {
  key: string
  kind: 'test_run' | 'exploration' | 'journey'
  sourceId: string
  recordingId: string | null
  title: string
  status: string
  isLive: boolean
  bugs: number
  journeyId: string | null
  startedAt: string | null
}

type Overview = {
  project: { id: string; name: string; target_url: string | null; status: string } | null
  /** The QA server's API base when it is not the default one (a PR preview, staging). */
  server?: string | null
  error: string | null
  updatedAt: number
  following: boolean
  counts: { live: number; journeys: number; bugs: number; failed: number }
  tiles: Tile[]
}

type RowKind = 'exploration' | 'test_run'

/** A transcript row that holds a live player. */
type Row = { projectId: string; recordingId: string; kind: RowKind; sourceId: string; title: string }

type PlayerAction = 'play' | 'pause' | 'toggle' | 'seek' | 'seekBy' | 'replay' | 'stop'

type Pending = { rowId: string; projectId: string; since: number; journeyId?: string }

const PANE = 'replay-qa-canvas'
const IMAGE_KEY = 'player'
const CANVAS_KEY = 'canvas'
const STORE_PREFIX = 'qa-player:'
const LAST_PROJECT_KEY = 'qa-last-project'
const MAX_CELLS = 255
// A terminal cell is about twice as tall as it is wide.
const CELL_ASPECT = 2.1
const OVERVIEW_MS = 4_000
const PENDING_MS = 1_500
/** A re-test the backend was asked to start is awaited this long. */
const PENDING_GIVE_UP_MS = 90_000
/** A followed project with no live work is let go after this, unless its canvas is open. */
const IDLE_UNFOLLOW_MS = 15 * 60_000

const state = {
  /** The session's working directory: where a Bash command runs unless it `cd`s. */
  cwd: null as string | null,
  relay: null as Relay | null,
  relayError: null as string | null,
  hasLogo: false,
  /** Transcript row (tool_use_id) -> the player it holds. */
  rows: new Map<string, Row>(),
  /** Why a row has no player (the relay refused, the token is missing). */
  rowErrors: new Map<string, string>(),
  frames: {} as Record<string, FrameInfo>,
  /** What each Image was last drawn with, so a frame of the same size can be blitted. */
  mounted: new Map<string, { columns: number; rows: number; width: number; height: number }>(),
  offscreen: new Set<string>(),
  watcher: 0,
  overviewWatcher: 0,
  lastProjectId: null as string | null,
  overviews: new Map<string, Overview>(),
  /** project id -> when it last had live work (or was followed), for letting idle ones go. */
  activeAt: new Map<string, number>(),
  pending: [] as Pending[],
  /** Recordings a restored row asked the relay to load again. */
  requested: new Set<string>(),
  /** Recordings that ended while their screencast was live, parked at the end. */
  parked: new Set<string>(),
  canvasProjectId: null as string | null,
  /** Where the canvas picture sits in the pane body, for the wheel; the screencast size last asked for. */
  canvasPicture: null as { top: number; columns: number; rows: number } | null,
  canvasAsked: null as { width: number; height: number } | null,
  /** The drag being applied to the canvas camera: its id and how far it has moved it so far. */
  cameraDrag: null as { id: number; dx: number; dy: number } | null,
  /** The canvas camera as its last move left it: the zoom, and where the minimap sits (fractions of the picture). */
  camera: null as CameraState | null,
  /** Camera moves go to the relay one after another, in order. */
  cameraQueue: Promise.resolve() as Promise<unknown>,
  statusLine: undefined as string | undefined,
}

// ------------------------------------------------------------------- relay

const relayUrl = (path: string) => {
  const relay = state.relay
  if (!relay) throw new Error('the Replay QA relay is not running')
  const join = path.includes('?') ? '&' : '?'
  return `http://127.0.0.1:${relay.port}${path}${join}token=${relay.token}`
}

async function relayJson<T>($: EngineInterface, path: string, body?: unknown): Promise<T> {
  const response = await $.http.fetch(relayUrl(path), body === undefined
    ? {}
    : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  const parsed = response.text ? JSON.parse(response.text) : null
  if (!response.ok) throw new Error(parsed?.error ?? `relay answered ${response.status}`)
  return parsed as T
}

/** Starts the relay for the session's life and resolves once it is listening. */
function startRelay($: EngineInterface): Promise<Relay> {
  return new Promise((resolve, reject) => {
    void (async () => {
      let stdout = ''
      let ready = false
      try {
        const child = $.process.spawn({ argv: ['node', `${$.plugin.root}/live/relay.mjs`] })
        for await (const piece of child) {
          if (piece.stream === 'stderr') {
            $.ui.log(piece.text.trimEnd(), { to: 'debug' })
            continue
          }
          if (ready) continue
          stdout += piece.text
          const line = stdout.split('\n').find(text => text.startsWith('{') && text.endsWith('}'))
          if (!line) continue
          ready = true
          resolve(JSON.parse(line) as Relay)
        }
      } catch (err) {
        if (!ready) reject(err)
      }
      state.relay = null
      if (!ready) reject(new Error(`relay exited before listening: ${stdout.slice(-300)}`))
    })()
  })
}

const message = (err: unknown) => (err instanceof Error ? err.message : String(err))

/** The frame id the relay gives a project's canvas screencast. */
const canvasFrameId = (projectId: string) => `canvas-${projectId.replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 120)}`

function imageSource(frame: { file: string; generation: number }) {
  return { file: frame.file, format: 'png' as const, generation: frame.generation }
}

function openUrl($: EngineInterface, url: string): void {
  // The URL carries the relay's token: never put it in a toast or the transcript.
  void $.process.run(['open', url]).catch(() => $.ui.toast('Could not open the browser'))
}

const playerPage = (recordingId: string) => relayUrl(`/player/${encodeURIComponent(recordingId)}?mode=auto&chrome=1`)
const canvasPage = (projectId: string) => relayUrl(`/canvas/${encodeURIComponent(projectId)}`)

// ---------------------------------------------------------------- projects

/**
 * `.replay/config.json` at the git root: the scripts keep `qa-project-id` there, and the replayqa
 * CLI the QA server its tunnel talks to (`proxy.qa-url`, set for a PR preview or staging).
 */
async function readConfig($: EngineInterface): Promise<{ projectId: string | null; qaUrl: string | null }> {
  try {
    const top = await $.process.run(['git', 'rev-parse', '--show-toplevel'], { timeoutMs: 5_000, ...(state.cwd ? { cwd: state.cwd } : {}) })
    const root = top.exitCode === 0 ? top.stdout.trim() : state.cwd
    if (!root) return { projectId: null, qaUrl: null }
    const config = JSON.parse(await $.fs.read(`${root}/.replay/config.json`)) as Record<string, any>
    const text = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : null)
    return { projectId: text(config['qa-project-id']), qaUrl: text(config.proxy?.['qa-url']) }
  } catch {
    return { projectId: null, qaUrl: null }
  }
}

/** The project to act on: the one named, else the repo's configured one, else the last seen. */
async function resolveProjectId($: EngineInterface, named?: string | null): Promise<string | null> {
  return named || (await readConfig($)).projectId || state.lastProjectId
}

/**
 * A `/replayqa` argument: a project id, or a dashboard URL, which also names the QA server, such
 * as a PR preview's `https://pr-1--qa.netlify.app/projects/proj-x/test-runs/…`.
 */
function parseProjectArg(arg: string | undefined): { projectId?: string; server?: string } {
  if (!arg) return {}
  const projectId = /proj-[A-Za-z0-9_-]+/.exec(arg)?.[0]
  return { ...(projectId ? { projectId } : {}), ...(/^https?:\/\//.test(arg) ? { server: arg } : {}) }
}

/** The QA server a project is on when nothing named one: the repo's `proxy.qa-url`, for the repo's project. */
async function configServer($: EngineInterface, projectId: string): Promise<string | undefined> {
  const config = await readConfig($)
  return config.qaUrl && config.projectId === projectId ? config.qaUrl : undefined
}

async function rememberProject($: EngineInterface, projectId: string): Promise<void> {
  if (state.lastProjectId === projectId) return
  state.lastProjectId = projectId
  await $.store.set(LAST_PROJECT_KEY, projectId)
}

/**
 * Turns the project's running work into recordings as it starts; resolves with its overview.
 * `server` names the QA server it is on when that is not the default (the relay also finds a
 * running `replayqa proxy --qa-url` tunnel for it by itself).
 */
async function followProject($: EngineInterface, projectId: string, server?: string): Promise<Overview> {
  const overview = await relayJson<Overview>($, '/qa/follow', { projectId, on: true, ...(server ? { server } : {}) })
  state.overviews.set(projectId, overview)
  state.activeAt.set(projectId, Date.now())
  await rememberProject($, projectId)
  if (overview.error) $.ui.toast(`Replay QA: ${overview.error}`)
  return overview
}

async function unfollowProject($: EngineInterface, projectId: string): Promise<void> {
  await relayJson($, '/qa/follow', { projectId, on: false })
  state.overviews.delete(projectId)
  state.activeAt.delete(projectId)
}

function liveCount(): number {
  let total = 0
  for (const o of state.overviews.values()) total += o.counts.live
  return total
}

function updateStatusLine($: EngineInterface): void {
  const live = liveCount()
  const line = live > 0 ? `◉ Replay QA: ${live} live` : undefined
  if (line === state.statusLine) return
  state.statusLine = line
  $.ui.status(line)
}

// ------------------------------------------------------------------ players

/** Gives a transcript row the player of one exploration or run, and starts its screencast. */
async function attachRow(
  $: EngineInterface,
  rowId: string,
  spec: { projectId: string; kind: RowKind; sourceId: string; title: string; goal?: string | null },
): Promise<void> {
  try {
    const watched = await relayJson<{ recording: RecordingInfo }>($, '/qa/watch', {
      projectId: spec.projectId, kind: spec.kind, sourceId: spec.sourceId, title: spec.title, goal: spec.goal ?? null,
    })
    const row: Row = { projectId: spec.projectId, recordingId: watched.recording.id, kind: spec.kind, sourceId: spec.sourceId, title: spec.title }
    state.rows.set(rowId, row)
    state.rowErrors.delete(rowId)
    await $.store.set(`${STORE_PREFIX}${rowId}`, row)
    await relayJson($, `/recordings/${encodeURIComponent(row.recordingId)}/player`, { mode: 'live' })
  } catch (err) {
    state.rowErrors.set(rowId, message(err))
    $.ui.toast(`Replay QA: ${message(err)}`)
  }
  $.ui.invalidate('ui.render')
}

/**
 * The live test run a re-test the backend was asked to start became. Other journeys may be running
 * too, so a run is taken only if it is of the journey re-tested, or (the journey unknown) started
 * after the command did.
 */
function freshLiveRun(projectId: string, want: { journeyId?: string; since: number }): Tile | undefined {
  const shown = new Set([...state.rows.values()].map(r => r.recordingId))
  const live = (state.overviews.get(projectId)?.tiles ?? []).filter(t => t.isLive && t.kind === 'test_run' && t.recordingId && !shown.has(t.recordingId))
  if (want.journeyId) return live.find(t => t.journeyId === want.journeyId)
  return live.find(t => (t.startedAt ? Date.parse(t.startedAt) : 0) >= want.since - 10_000)
}

/** Rows waiting for a re-test run get it as soon as the project overview shows one running. */
async function settlePending($: EngineInterface): Promise<void> {
  if (state.pending.length === 0) return
  const waiting: Pending[] = []
  for (const item of state.pending) {
    const tile = freshLiveRun(item.projectId, item)
    if (tile) {
      await attachRow($, item.rowId, { projectId: item.projectId, kind: 'test_run', sourceId: tile.sourceId, title: tile.title })
    } else if (Date.now() - item.since < PENDING_GIVE_UP_MS) {
      waiting.push(item)
    } else {
      state.rowErrors.set(item.rowId, 'No test run started yet: the backend may still be queueing it. Open the canvas to watch for it.')
      $.ui.invalidate('ui.render')
    }
  }
  state.pending = waiting
}

/**
 * What a Replay QA call (a Bash script, or a QA MCP tool) did: follow its project, and give the
 * row the exploration it started, or the re-test run it caused.
 */
async function handleQaResult(
  $: EngineInterface,
  rowId: string,
  command: QaCommand | null,
  output: string,
  since: number,
): Promise<void> {
  const parsed = parseQaOutput(output)
  const startedExploration = parsed.explorationId && isRunningStatus(parsed.explorationStatus) && (!command || command.script === 'start-exploration')
  const wantsFollow = Boolean(startedExploration || command?.startsRun || (command && ['status', 'full-qa', 'bootstrap'].includes(command.script)))
  if (!wantsFollow) return
  const projectId = parsed.projectId ?? (await resolveProjectId($, command?.projectId))
  if (!projectId) {
    $.ui.log('replay-qa: no project id in the output, the arguments or .replay/config.json')
    return
  }
  const server = command?.server ?? parsed.qaUrl ?? (await configServer($, projectId))
  const overview = await followProject($, projectId, server)
  if (startedExploration && parsed.explorationId) {
    await attachRow($, rowId, {
      projectId, kind: 'exploration', sourceId: parsed.explorationId,
      title: parsed.prompt ? `Exploration: ${parsed.prompt.slice(0, 70)}` : `Exploration ${parsed.explorationId}`, goal: parsed.prompt,
    })
  } else if (command?.startsRun) {
    // The backend queues the run on its own; the row takes the first live run that appears.
    const want = { journeyId: parsed.journeyId, since }
    const tile = freshLiveRun(projectId, want)
    if (tile) await attachRow($, rowId, { projectId, kind: 'test_run', sourceId: tile.sourceId, title: tile.title })
    else if (!overview.error) state.pending.push({ rowId, projectId, ...want })
  }
}

async function play($: EngineInterface, recordingId: string, mode: PlayerAction, ms?: number): Promise<void> {
  try {
    await relayJson($, `/recordings/${encodeURIComponent(recordingId)}/player`, { mode, ms })
  } catch (err) {
    $.ui.toast(`Replay QA player: ${message(err)}`)
  }
}

/** After a restart a row has no player: ask the relay to load its recording again, once. */
async function reviveRow($: EngineInterface, row: Row): Promise<void> {
  if (state.requested.has(row.recordingId)) return
  state.requested.add(row.recordingId)
  try {
    await relayJson($, '/qa/watch', { projectId: row.projectId, kind: row.kind, sourceId: row.sourceId, title: row.title })
    await relayJson($, `/recordings/${encodeURIComponent(row.recordingId)}/player`, { mode: 'live' })
  } catch (err) {
    state.requested.delete(row.recordingId)
    $.ui.log(`replay-qa: could not load ${row.recordingId}: ${message(err)}`)
  }
}

// ------------------------------------------------------------------ canvas

async function showCanvas($: EngineInterface, projectId: string, server?: string): Promise<void> {
  await followProject($, projectId, server)
  state.canvasProjectId = projectId
  await $.ui.open({ id: PANE, title: 'Replay QA', rows: 26 })
  await relayJson($, `/canvas/${encodeURIComponent(projectId)}/view`, { on: true, width: 1600, height: 900 })
  $.ui.invalidate('ui.render')
}

async function hideCanvas($: EngineInterface): Promise<void> {
  const projectId = state.canvasProjectId
  state.canvasProjectId = null
  state.canvasPicture = null
  state.canvasAsked = null
  state.camera = null
  if (projectId) await relayJson($, `/canvas/${encodeURIComponent(projectId)}/view`, { on: false }).catch(() => {})
}

type CameraMove =
  | { op: 'zoom'; factor: number; x?: number; y?: number }
  | { op: 'pan'; dx: number; dy: number }
  | { op: 'focus'; x: number; y: number }
  | { op: 'minimap'; x: number; y: number }
  | { op: 'fit' }
  | { op: 'actual' }
  | { op: 'state' }

type Rect = { x: number; y: number; w: number; h: number }
type CameraState = { k: number; minimap: Rect | null }

/**
 * Moves the canvas screencast's camera (points and distances are fractions of the picture), and keeps
 * what it answers: the zoom the footer shows and the minimap the camera layer lets the pointer jump on.
 */
function moveCamera($: EngineInterface, move: CameraMove): void {
  const projectId = state.canvasProjectId
  if (!projectId) return
  state.cameraQueue = state.cameraQueue
    .then(async () => {
      const { result } = await relayJson<{ result: CameraState | null }>($, `/canvas/${encodeURIComponent(projectId)}/camera`, move)
      if (!result || typeof result.k !== 'number' || state.canvasProjectId !== projectId) return
      const before = state.camera
      state.camera = { k: result.k, minimap: result.minimap ?? null }
      const pct = (c: CameraState | null) => (c ? Math.round(c.k * 100) : null)
      if (pct(before) !== pct(state.camera) || JSON.stringify(before?.minimap) !== JSON.stringify(state.camera.minimap)) $.ui.invalidate('ui.render')
    })
    .catch(err => $.ui.log(`replay-qa: canvas camera: ${message(err)}`))
}

/** The screencast takes the pane picture's shape: asked again when it changes by more than a little. */
function sizeCanvas($: EngineInterface, projectId: string, columns: number, rows: number): void {
  const width = 1600
  const height = Math.round((width * rows * CELL_ASPECT) / columns)
  const asked = state.canvasAsked
  if (asked && Math.abs(asked.height - height) / asked.height < 0.04) return
  state.canvasAsked = { width, height }
  void relayJson($, `/canvas/${encodeURIComponent(projectId)}/view`, { on: true, width, height })
    .then(() => moveCamera($, { op: 'state' }))
    .catch(err => $.ui.log(`replay-qa: canvas resize: ${message(err)}`))
}

const fraction = (v: unknown, lo = 0, hi = 1) => (typeof v === 'number' && Number.isFinite(v) ? Math.max(lo, Math.min(hi, v)) : null)

// ---------------------------------------------------------------- watchers

/** Follows the relay's frame feed: blits new frames, parks ended streams, redraws on change. */
async function watchFrames($: EngineInterface): Promise<void> {
  const watcher = ++state.watcher
  let version = -1
  while (state.watcher === watcher && state.relay) {
    let snapshot: { version: number; frames: Record<string, FrameInfo> }
    try {
      snapshot = await relayJson($, `/frames?version=${version}`)
    } catch {
      await $.clock.sleep(1000)
      continue
    }
    version = snapshot.version
    let redraw = false
    for (const [id, fresh] of Object.entries(snapshot.frames)) {
      const before = state.frames[id]
      state.frames[id] = fresh
      if (fresh.kind === 'canvas') {
        if (!state.canvasProjectId || id !== canvasFrameId(state.canvasProjectId)) continue
        const mounted = state.mounted.get(PANE)
        const fits = mounted && mounted.width === fresh.width && mounted.height === fresh.height
        if (!before || !fits || before.generation === 0 || before.status !== fresh.status) {
          redraw = true
        } else if (fresh.generation !== before.generation) {
          const blit = await $.ui.blit({ requestId: PANE, key: CANVAS_KEY, source: imageSource(fresh) })
          if (blit.deny) redraw = true
        }
        continue
      }
      const rec = fresh.recording
      // A stream that ended while its screencast followed it live is parked on its last moment.
      if (rec && rec.status === 'ended' && fresh.mode === 'live' && !state.parked.has(id)) {
        state.parked.add(id)
        await play($, id, 'seek', rec.durationMs)
      }
      const rows = [...state.rows.entries()].filter(([, row]) => row.recordingId === id)
      if (rows.length === 0) continue
      const changedShape = !before
        || before.status !== fresh.status
        || before.mode !== fresh.mode
        || before.seq !== fresh.seq
        || before.totalMs !== fresh.totalMs
        || before.recording?.status !== rec?.status
        || before.recording?.note?.text !== rec?.note?.text
        || before.recording?.lastError !== rec?.lastError
        || Math.floor((before.recording?.eventCount ?? 0) / 25) !== Math.floor((rec?.eventCount ?? 0) / 25)
      for (const [rowId] of rows) {
        const mounted = state.mounted.get(rowId)
        const fits = mounted && mounted.width === fresh.width && mounted.height === fresh.height
        if (changedShape || !fits || before?.generation === 0) {
          redraw = true
          continue
        }
        if (fresh.generation === before?.generation || state.offscreen.has(rowId)) continue
        const blit = await $.ui.blit({ requestId: rowId, key: IMAGE_KEY, source: imageSource(fresh) })
        if (blit.deny) redraw = true
      }
    }
    if (redraw) $.ui.invalidate('ui.render')
  }
}

/** Keeps each followed project's overview fresh (status line, canvas header) and settles waiting rows. */
async function watchOverviews($: EngineInterface): Promise<void> {
  const watcher = ++state.overviewWatcher
  while (state.overviewWatcher === watcher && state.relay) {
    let changed = false
    for (const projectId of [...state.overviews.keys()]) {
      try {
        const before = state.overviews.get(projectId)
        const overview = await relayJson<Overview>($, `/qa/overview?project=${encodeURIComponent(projectId)}`)
        state.overviews.set(projectId, overview)
        if (!before || before.counts.live !== overview.counts.live || before.error !== overview.error || before.counts.bugs !== overview.counts.bugs || before.counts.failed !== overview.counts.failed) changed = true
        if (overview.counts.live > 0 || state.canvasProjectId === projectId) state.activeAt.set(projectId, Date.now())
        else if (Date.now() - (state.activeAt.get(projectId) ?? Date.now()) > IDLE_UNFOLLOW_MS) await unfollowProject($, projectId)
      } catch (err) {
        $.ui.log(`replay-qa: overview of ${projectId}: ${message(err)}`)
      }
    }
    await settlePending($)
    updateStatusLine($)
    if (changed && state.canvasProjectId) $.ui.invalidate('ui.render')
    // The canvas fits itself as tiles come and go: keep the zoom and the minimap the pane shows in step.
    if (state.canvasProjectId) moveCamera($, { op: 'state' })
    await $.clock.sleep(state.pending.length ? PENDING_MS : OVERVIEW_MS)
  }
}

// ----------------------------------------------------------------- drawing

function recordingLabel(row: Row, rec: RecordingInfo | null | undefined): string {
  const what = row.kind === 'exploration' ? 'exploration' : 'journey'
  const events = rec ? ` · ${rec.eventCount.toLocaleString()} events` : ''
  const state = !rec ? 'starting' : rec.status === 'live' ? '◉ LIVE' : rec.status === 'loading' ? '… loading' : rec.status === 'error' ? '⚠ error' : '■ ended'
  return `Replay QA · ${what}  ${state}${events}`
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    state.cwd = e.cwd
    const started = await next(e)
    try {
      state.hasLogo = await $.fs.exists(`${$.plugin.root}/assets/replay-logo.png`)
    } catch {}
    for (const key of await $.store.keys()) {
      if (key.startsWith(STORE_PREFIX)) {
        const row = (await $.store.get(key)) as Row | undefined
        if (row?.recordingId) state.rows.set(key.slice(STORE_PREFIX.length), row)
      } else if (key === LAST_PROJECT_KEY) {
        const id = await $.store.get(key)
        if (typeof id === 'string') state.lastProjectId = id
      }
    }
    try {
      state.relay = await startRelay($)
      // They end with the session: a wait the unloading engine aborts is not an error.
      void watchFrames($).catch(() => {})
      void watchOverviews($).catch(() => {})
    } catch (err) {
      state.relayError = message(err)
      $.ui.log(`replay-qa: live relay did not start: ${state.relayError}`)
    }
    await $.command.register({
      name: 'replayqa',
      description: 'Live Replay QA: the canvas of every journey, running explorations and re-tests',
      argumentHint: '[canvas|follow|unfollow|live|open] [project id, dashboard URL or recording]',
    })
    return started
  })

  on('command.run', { command: 'replayqa' }, async ($, e) => {
    if (!state.relay) return { text: `The Replay QA relay is not running${state.relayError ? `: ${state.relayError}` : ''}.` }
    const [verb = '', arg] = e.args.trim().split(/\s+/)
    try {
      if (verb === 'canvas' || verb === 'follow' || verb === 'unfollow') {
        const named = parseProjectArg(arg)
        const projectId = await resolveProjectId($, named.projectId)
        if (!projectId) return { text: 'No Replay QA project: pass its id (proj-…) or dashboard URL, or run a Replay QA script first so .replay/config.json names one.' }
        const server = named.server ?? (await configServer($, projectId))
        if (verb === 'unfollow') {
          await unfollowProject($, projectId)
          updateStatusLine($)
          return { text: `No longer following ${projectId}.` }
        }
        if (verb === 'canvas') {
          await showCanvas($, projectId, server)
          const o = state.overviews.get(projectId)
          return { text: `Replay QA canvas for ${o?.project?.name ?? projectId}: ${o?.counts.live ?? 0} live, ${o?.counts.journeys ?? 0} journeys. Running work streams in as it starts.` }
        }
        const o = await followProject($, projectId, server)
        return { text: `Following ${o.project?.name ?? projectId}: ${o.counts.live} live. Running explorations and test runs stream into the canvas (/replayqa canvas).` }
      }
      if (verb === 'live' || verb === 'open') {
        const recordings = await relayJson<RecordingInfo[]>($, '/recordings')
        if (verb === 'open') {
          const rec = [...recordings].reverse().find(r => !arg || arg === 'latest' || r.id === arg || r.sourceId === arg)
          if (!rec) return { text: recordings.length ? `No recording matches ${arg}.` : 'No Replay QA recordings yet.' }
          openUrl($, playerPage(rec.id))
          return { text: `Opened ${rec.title} (${rec.id}) in your browser.` }
        }
        const live = recordings.filter(r => r.status === 'live' || r.status === 'loading')
        if (live.length === 0) return { text: 'Nothing is running in the Replay QA projects being followed.' }
        return { text: `Live now:\n${live.map(r => `- ◉ ${r.title} (${r.id}) · ${r.eventCount.toLocaleString()} events`).join('\n')}\n\nOpen one with /replayqa open <id>.` }
      }
      const followed = [...state.overviews.values()]
      if (followed.length === 0) return { text: `Replay QA live view is ready. Start an exploration, or use /replayqa canvas${state.lastProjectId ? ` (last project ${state.lastProjectId})` : ' <project id>'}.` }
      return { text: `Following ${followed.map(o => `${o.project?.name ?? '?'} (${o.counts.live} live, ${o.counts.journeys} journeys, ${o.counts.bugs} with bugs)`).join('; ')}. /replayqa canvas shows them all.` }
    } catch (err) {
      return { text: `Replay QA: ${message(err)}` }
    }
  })

  // What the Clients post: the canvas camera layer (drags, double-clicks and keys over the picture), and
  // a player row's seek bar. Validated: it is client input.
  on('ui.message', async ($, e, next) => {
    // `e.module` is the path under the plugin's folder (`hooks/camera.tsx`); the `./` form is the Client's own.
    const module = e.module.replace(/^(?:\.\/|hooks\/)/, '')
    if (module === 'scrubber.tsx') {
      const row = state.rows.get(e.requestId)
      const data = e.data as { type?: string; ms?: number }
      if (row && (data.type === 'seek' || data.type === 'seekBy' || data.type === 'toggle')) await play($, row.recordingId, data.type, data.ms)
      return next(e)
    }
    if (module !== 'camera.tsx' || e.requestId !== PANE) return next(e)
    const data = (e.data ?? {}) as Record<string, unknown>
    if (data.type === 'drag' && typeof data.id === 'number') {
      const dx = fraction(data.dx, -4, 4) ?? 0
      const dy = fraction(data.dy, -4, 4) ?? 0
      const prev = state.cameraDrag?.id === data.id ? state.cameraDrag : { id: data.id, dx: 0, dy: 0 }
      state.cameraDrag = { id: data.id, dx, dy }
      if (dx !== prev.dx || dy !== prev.dy) moveCamera($, { op: 'pan', dx: dx - prev.dx, dy: dy - prev.dy })
    } else if (data.type === 'focus') {
      moveCamera($, { op: 'focus', x: fraction(data.x) ?? 0.5, y: fraction(data.y) ?? 0.5 })
    } else if (data.type === 'minimap') {
      moveCamera($, { op: 'minimap', x: fraction(data.x) ?? 0.5, y: fraction(data.y) ?? 0.5 })
    } else if (data.type === 'zoom') {
      moveCamera($, { op: 'zoom', factor: fraction(data.factor, 0.5, 2) ?? 1 })
    } else if (data.type === 'pan') {
      moveCamera($, { op: 'pan', dx: fraction(data.dx, -1, 1) ?? 0, dy: fraction(data.dy, -1, 1) ?? 0 })
    } else if (data.type === 'fit' || data.type === 'actual') {
      moveCamera($, { op: data.type })
    }
    return next(e)
  })

  // The wheel over the canvas picture zooms around the pointer; elsewhere the pane scrolls as usual.
  on('ui.scroll', { component: 'Pane', requestId: PANE }, async ($, e, next) => {
    const picture = state.canvasPicture
    const p = e.pointer
    if (!picture || !p || e.origin.kind !== 'person') return next(e)
    const row = p.row - picture.top
    if (row < 0 || row >= picture.rows || p.column < 0 || p.column >= picture.columns) return next(e)
    moveCamera($, { op: 'zoom', factor: Math.pow(1.15, -Math.max(-6, Math.min(6, e.by))), x: (p.column + 0.5) / picture.columns, y: (row + 0.5) / picture.rows })
    return { deny: 'the canvas zoomed instead' }
  })

  // The result of a Replay QA script run from Bash.
  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    if (e.run_in_background) return next(e)
    const command = parseQaCommand(e.command)
    const since = Date.now()
    const ran = await next(e)
    if (!command || ran.deny !== undefined || ran.isError || !state.relay) return ran
    try {
      await handleQaResult($, e.tool_use_id, command, ran.text ?? '', since)
    } catch (err) {
      $.ui.log(`replay-qa: ${message(err)}`)
      $.ui.toast(`Replay QA live view: ${message(err)}`)
    }
    return ran
  })

  // The same for the Replay QA MCP server's tools (an exploration started through them).
  on('tool.call', { tool: /^mcp__.*replay[-_]?qa.*__/ }, async ($, e, next) => {
    const since = Date.now()
    const ran = await next(e)
    if (ran.deny !== undefined || ran.isError || !state.relay) return ran
    try {
      await handleQaResult($, e.tool_use_id, null, ran.text ?? '', since)
    } catch (err) {
      $.ui.log(`replay-qa: ${message(err)}`)
    }
    return ran
  })

  // The engine folds runs of tool calls into one count line; a group that holds a player is unfolded.
  on('ui.render', { component: 'ToolGroup' }, ($, e, next) =>
    !e.props.isExpanded && e.props.calls.some(c => c.tool_use_id && state.rows.has(c.tool_use_id))
      ? next({ ...e, props: { ...e.props, isExpanded: true } })
      : next(e))

  // The call's result block would repeat the player.
  on('ui.render', { component: 'ToolResult' }, ($, e, next) => {
    if (!state.rows.has(e.requestId) || e.props.isErrored) return next(e)
    const { Box } = $.ui.resolve(e)
    return <Box />
  })

  on('ui.render', { component: 'ToolUse' }, async ($, e, next) => {
    const id = e.requestId
    const row = state.rows.get(id)
    const rowError = state.rowErrors.get(id)
    const waiting = state.pending.some(p => p.rowId === id)
    if ((!row && !rowError && !waiting) || e.props.isErrored) return next(e)
    if (e.props.onScreen === null) state.offscreen.add(id)
    else state.offscreen.delete(id)

    const ui = $.ui.resolve(e)
    const { Box, Text, Button } = ui
    const command = (e.props.input as { command?: string } | undefined)?.command?.split('\n')[0]
    const logo = e.surface === 'terminal' && state.hasLogo
      ? (() => {
          const { Image } = $.ui.resolve(e)
          return <Image key="logo" source={{ file: `${$.plugin.root}/assets/replay-logo.png`, format: 'png' }} columns={2} rows={1} alt="◆" />
        })()
      : <Text color="#F02D5E" bold>◆</Text>
    const header = (label: string, live = false) => (
      <Box flexDirection="row" gap={1}>
        {logo}
        <Text bold={live}>{label}</Text>
      </Box>
    )
    const commandLine = <Text dimColor wrap="truncate-end">$ {command ?? e.props.tool}</Text>

    if (!row) {
      return (
        <Box flexDirection="column">
          {commandLine}
          {header('Replay QA · live view')}
          {rowError ? <Text color="red" wrap="wrap">⚠ {rowError}</Text> : <Text dimColor>Waiting for the backend to start the run…</Text>}
          {state.canvasProjectId === null && state.lastProjectId ? <Button key="canvas" label="Open canvas" onPress={() => { void showCanvas($, state.lastProjectId!) }} /> : null}
        </Box>
      )
    }

    // A restored row has no player yet in a new session: ask the relay to load it, once.
    const frame = state.frames[row.recordingId]
    if (!frame && state.relay && e.props.onScreen !== null) void reviveRow($, row)

    const rec = frame?.recording
    const width = frame?.width ?? 1280
    const height = frame?.height ?? 720
    const columns = Math.max(20, Math.min(MAX_CELLS, (e.viewport?.columns ?? 100) - 6))
    const rows = Math.max(6, Math.min(48, Math.round((columns * height) / width / CELL_ASPECT)))
    const dataDir = state.relay?.dataDir
    const savedFrame = dataDir ? `${dataDir}/frames/${row.recordingId.replace(/[^A-Za-z0-9_.-]/g, '_')}.png` : null
    const source = frame && frame.generation > 0
      ? imageSource(frame)
      : savedFrame && (await $.fs.exists(savedFrame)) ? imageSource({ file: savedFrame, generation: 0 }) : null

    const isFollowing = rec?.status === 'live' || rec?.status === 'loading'
    const isLive = isFollowing && frame?.mode === 'live'
    const isPlaying = frame?.status === 'playing' && frame.mode === 'replay'
    const error = rowError ?? rec?.error ?? rec?.lastError ?? null
    const picture = !source
      ? <Text dimColor>{state.relay ? (rec?.status === 'error' ? 'No picture: the recording could not be read.' : 'Waiting for the first frame…') : 'The Replay QA relay is not running.'}</Text>
      : e.surface === 'terminal'
        ? (() => {
            state.mounted.set(id, { columns, rows, width, height })
            const { Image } = $.ui.resolve(e)
            return <Image key={IMAGE_KEY} source={source} columns={columns} rows={rows} alt={`Replay QA ${row.title}`} />
          })()
        : <Text dimColor>Inline frames draw in the terminal; use Open in browser.</Text>

    const scrubber = e.surface === 'terminal' && state.relay && frame
      ? (() => {
          const { Client } = $.ui.resolve(e)
          return (
            <Client
              key="scrubber"
              module="./scrubber.tsx"
              width={columns}
              height={1}
              props={{ currentMs: frame.currentMs ?? 0, totalMs: frame.totalMs ?? 0, isPlaying, at: frame.at ?? Date.now(), isLive }}
            />
          )
        })()
      : null

    return (
      <Box flexDirection="column">
        {commandLine}
        {header(recordingLabel(row, rec), isLive)}
        <Text dimColor wrap="truncate-end">{row.title}</Text>
        {picture}
        {scrubber}
        {rec?.note?.text ? <Text dimColor wrap="truncate-end">▸ {rec.note.step ? `step ${rec.note.step.index}: ` : ''}{rec.note.text}</Text> : null}
        {error ? <Text color="red" wrap="wrap">⚠ {error}</Text> : null}
        {state.relay ? (
          <Box flexDirection="row" gap={1} flexWrap="wrap">
            {isLive
              ? <Button key="stop" label="■ Stop preview" onPress={() => play($, row.recordingId, 'stop')} />
              : (
                <Box flexDirection="row" gap={1}>
                  <Button key="start" label="⏮" onPress={() => play($, row.recordingId, 'seek', 0)} />
                  <Button key="back" label="−10s" onPress={() => play($, row.recordingId, 'seekBy', -10_000)} />
                  <Button key="toggle" variant="primary" label={isPlaying ? '❚❚ Pause' : '▶ Play'} onPress={() => play($, row.recordingId, isPlaying ? 'pause' : 'play')} />
                  <Button key="fwd" label="+10s" onPress={() => play($, row.recordingId, 'seekBy', 10_000)} />
                </Box>
              )}
            <Button key="canvas" label="Show canvas pane" onPress={() => { void showCanvas($, row.projectId) }} />
            <Button key="open-canvas" label="Open canvas" onPress={() => openUrl($, canvasPage(row.projectId))} />
            <Button key="open" label="Open in browser" onPress={() => openUrl($, playerPage(row.recordingId))} />
          </Box>
        ) : null}
      </Box>
    )
  })

  // The canvas pane: every journey of the project as rrweb players, as one picture.
  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const projectId = state.canvasProjectId
    const { Box, Text, Button } = $.ui.resolve(e)
    if (!projectId) return <Text dimColor>No project: run /replayqa canvas &lt;project id&gt;.</Text>
    const overview = state.overviews.get(projectId)
    const frame = state.frames[canvasFrameId(projectId)]
    const bodyRows = e.props.scroll.bodyRows > 0 ? e.props.scroll.bodyRows : Math.max(8, (e.viewport?.rows ?? 30) - 8)
    // The picture is the canvas, filling the pane between the header line and the footer line;
    // the screencast is asked for that shape, so nothing is letterboxed.
    const columns = Math.max(20, Math.min(MAX_CELLS, e.props.bodyColumns > 0 ? e.props.bodyColumns : (e.viewport?.columns ?? 100)))
    const rows = Math.max(6, bodyRows - 2)
    const width = frame?.width ?? 1600
    const height = frame?.height ?? 900

    const name = overview?.project?.name ?? projectId
    const counts = overview?.counts
    const server = overview?.server ? new URL(overview.server).host : null
    const header = (
      <Box flexDirection="row" gap={2} height={1} overflow="hidden">
        <Text bold wrap="truncate-end">{name}</Text>
        <Text color={counts && counts.live > 0 ? '#F02D5E' : undefined} dimColor={!counts || counts.live === 0}>● {counts?.live ?? 0} live</Text>
        <Text dimColor wrap="truncate-end">{counts?.journeys ?? 0} journeys · {counts?.bugs ?? 0} with bugs · {counts?.failed ?? 0} failed{server ? ` · ${server}` : ''}</Text>
      </Box>
    )
    const picture = e.surface !== 'terminal'
      ? <Text dimColor>The canvas draws in the terminal; open it in a browser with the button below.</Text>
      : frame && frame.generation > 0
        ? (() => {
            state.mounted.set(PANE, { columns, rows, width, height })
            state.canvasPicture = { top: 1, columns, rows }
            sizeCanvas($, projectId, columns, rows)
            const { Image, Client } = $.ui.resolve(e)
            return (
              <Box key="stage" width={columns} height={rows}>
                <Image key={CANVAS_KEY} source={imageSource(frame)} columns={columns} rows={rows} alt={`Replay QA canvas for ${name}`} />
                <Box position="absolute" top={0} left={0} width={columns} height={rows}>
                  <Client key="camera" module="./camera.tsx" width={columns} height={rows} props={{ minimap: state.camera?.minimap ?? null }} />
                </Box>
              </Box>
            )
          })()
        : <Text dimColor>{overview?.error ? `⚠ ${overview.error}` : 'Loading the canvas…'}</Text>
    return (
      <Box flexDirection="column">
        {header}
        {picture}
        <Box flexDirection="row" gap={1} height={1} overflow="hidden">
          <Button key="zoomOut" label="−" onPress={() => moveCamera($, { op: 'zoom', factor: 0.8 })} />
          <Button key="zoomPct" label={state.camera ? `${Math.round(state.camera.k * 100)}%` : '100%'} onPress={() => moveCamera($, { op: 'actual' })} />
          <Button key="zoomIn" label="+" onPress={() => moveCamera($, { op: 'zoom', factor: 1.25 })} />
          <Button key="fit" label="Fit" onPress={() => moveCamera($, { op: 'fit' })} />
          <Button key="open" label="Open in browser" onPress={() => openUrl($, canvasPage(projectId))} />
          <Button key="close" label="Close" onPress={() => { void $.ui.close({ id: PANE }) }} />
          {overview?.error && frame && frame.generation > 0
            ? <Text color="red" wrap="truncate-end">⚠ {overview.error}</Text>
            : <Text dimColor wrap="truncate-end">scroll to zoom · drag to pan · double-click a tile · click the minimap to jump</Text>}
        </Box>
      </Box>
    )
  })

  on('ui.close', { id: PANE }, async ($, e, next) => {
    const closed = await next(e)
    await hideCanvas($)
    return closed
  })
}
