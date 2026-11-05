/* @jsx h */
import { createDashboardQueue } from '../live/dashboard-queue.mjs'
import type { EngineInterface, Register } from 'claude-code'

import { isRunningStatus, jsonValues, parseQaCommand, parseQaOutput, type QaCommand } from './detect.ts'
import { drawFolder, type DetectedApp, type DetectedProject, type Detection, type FolderActions, type FolderData, type FolderUi, type Summary, type Tunnel } from './folder.tsx'

// Live Replay QA in the transcript. When Claude starts an exploration, or a bug marked fixed makes
// the backend re-test a journey, the relay (live/relay.mjs) reads that run's rrweb stream from the
// QA API as it happens, and a headless renderer plays it into PNG frames this module draws as an
// Image on the call's own row, scrubbable once it ends. `/replayqa` follows the session's folder: it
// opens a pane holding every journey of the folder's project as rrweb players, the running ones
// streaming in parallel, or the index of the folder's projects, or the list to set one up.

type Relay = { port: number; token: string; dataDir: string; hookToken?: string }

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
  authRequired?: boolean
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
/** One unscoped key once held the last project, whatever folder it was seen in: it is removed, not read. */
const OLD_LAST_PROJECT_KEY = 'qa-last-project'
/** The last project seen in a folder (its nearest config's, else its git root), under this and the folder. */
const LAST_PROJECT_PREFIX = 'qa-last-project:'
/** The pinned CLI, as the skill and the relay run it; REPLAY_QA_CLI runs a checkout instead. */
const REPLAYQA = ['npx', '--yes', 'replayqa@0.7.0']
/** The plugin's MCP server (.mcp.json), and the tool that lets a process run as the person who signed in to it. */
const MCP_SERVER = 'plugin:replay-qa:replay-qa'
const MCP_CREDENTIAL_TOOL = 'create_cli_credential'
/** After the MCP server had no sign-in to give, how long until a background check asks again. A person's command always asks. */
const SIGN_IN_RETRY_MS = 5 * 60_000
/** A slow or unreachable MCP server costs this at most: nothing here waits on it for longer. */
const MINT_TIMEOUT_MS = 8_000
const CLI_TIMEOUT_MS = 90_000
const MAX_CELLS = 255
// A terminal cell is about twice as tall as it is wide.
const CELL_ASPECT = 2.1
const OVERVIEW_MS = 4_000
const PENDING_MS = 1_500
/** A re-test the backend was asked to start is awaited this long. */
const PENDING_GIVE_UP_MS = 90_000
/** A followed project with no live work is let go after this, unless its dashboard is open. */
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
  /** The project a row with no player is about. */
  rowProjects: new Map<string, string>(),
  frames: {} as Record<string, FrameInfo>,
  /** What each Image was last drawn with, so a frame of the same size can be blitted. */
  mounted: new Map<string, { columns: number; rows: number; width: number; height: number }>(),
  offscreen: new Set<string>(),
  watcher: 0,
  overviewWatcher: 0,
  overviews: new Map<string, Overview>(),
  /** project id -> when it last had live work (or was followed), for letting idle ones go. */
  activeAt: new Map<string, number>(),
  pending: [] as Pending[],
  /** Recordings a restored row asked the relay to load again. */
  requested: new Set<string>(),
  /** Recordings that ended while their screencast was live, parked at the end. */
  parked: new Set<string>(),
  canvasProjectId: null as string | null,
  /** Why the dashboard has no picture (no renderer). */
  canvasError: null as string | null,
  /** Why this project is the one showing, when nothing in the folder names it. */
  canvasNote: null as string | null,
  /** What the pane holds: a project's dashboard, or the folder's index or setup list. */
  paneView: 'canvas' as 'canvas' | 'folder',
  /** The `replayqa` the plugin runs. */
  cli: REPLAYQA as readonly string[],
  /** What `replayqa detect` last said about the session's folder; null when it did not run. */
  detection: null as Detection | null,
  /** Why it did not run. */
  detectionWhy: null as string | null,
  folderName: '',
  folderView: 'setup' as 'index' | 'setup',
  folderBusy: null as string | null,
  folderError: null as string | null,
  /** An app waiting to be confirmed, by its setup's cwd. */
  confirm: null as { key: string; isBusy: boolean } | null,
  summaries: {} as Record<string, Summary>,
  /** The `replayqa run` processes the relay supervises for this session. */
  tunnels: [] as Tunnel[],
  /** The relay's sign-ins, as of the last time it was asked. */
  auth: { mcp: [] as { origin: string; expiresAt: number }[], existing: false, askedAt: 0 },
  /** What the MCP server last said to a request for a credential, for what the list tells the person to do. */
  mcpAnswer: null as 'gave' | 'needs-sign-in' | 'cannot-share' | null,
  signingIn: null as Promise<void> | null,
  browserLogin: null as Promise<void> | null,
  loginError: null as string | null,
  /** Where the dashboard picture sits in the pane body, for the wheel; the screencast size last asked for. */
  canvasPicture: null as { top: number; columns: number; rows: number } | null,
  canvasAsked: null as { width: number; height: number } | null,
  /** Browser input is forwarded in order. */
  dashboardQueue: null as { projectId: string; queue: ReturnType<typeof createDashboardQueue> } | null,
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
  // The header is what only this module has: what a page can do, its URL's token allows.
  const hook: Record<string, string> = state.relay?.hookToken ? { 'x-replay-qa-hook-token': state.relay.hookToken } : {}
  const response = await $.http.fetch(relayUrl(path), body === undefined
    ? { headers: hook }
    : { method: 'POST', headers: { 'content-type': 'application/json', ...hook }, body: JSON.stringify(body) })
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

/** The frame id the relay gives a project's dashboard screencast. */
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
const folderPage = () => relayUrl('/folder')

// ---------------------------------------------------------------- projects

/** The session's folder, and every folder from it up to the git root (it alone outside git). */
async function sessionFolder($: EngineInterface): Promise<{ cwd: string; dirs: string[] }> {
  // `/cd` and a worktree move the session; a hook's `$` says where it is now.
  const cwd = (await $.session.cwd().catch(() => null)) ?? state.cwd ?? '.'
  try {
    const git = await $.process.run(['git', 'rev-parse', '--show-toplevel', '--show-prefix'], { timeoutMs: 5_000, cwd })
    const [top, prefix = ''] = git.stdout.split('\n').map(line => line.trim())
    if (git.exitCode === 0 && top) {
      const parts = prefix.split('/').filter(Boolean)
      return { cwd, dirs: parts.map((_, i) => [top, ...parts.slice(0, parts.length - i)].join('/')).concat(top) }
    }
  } catch {}
  return { cwd, dirs: [cwd] }
}

type FolderConfig = {
  /** The folder the last-project fallback is kept under: the nearest config's, else the git root. */
  folderKey: string
  /** The folder of the nearest config, when there is one. */
  dir: string | null
  projectId: string | null
  qaUrl: string | null
}

/**
 * The nearest `.replay/config.json`, from the session's folder up to the git root: the replayqa CLI keeps
 * `qa-project-id` there, and the QA server its tunnel talks to (`proxy.qa-url`, set for a PR preview or
 * staging). The first one found wins, as it does for the CLI.
 */
async function readConfig($: EngineInterface): Promise<FolderConfig> {
  const { dirs } = await sessionFolder($)
  const text = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : null)
  for (const dir of dirs) {
    let raw: string
    try {
      raw = await $.fs.read(`${dir}/.replay/config.json`)
    } catch {
      continue
    }
    try {
      const config = JSON.parse(raw) as Record<string, any>
      return { folderKey: dir, dir, projectId: text(config['qa-project-id']), qaUrl: text(config.proxy?.['qa-url']) }
    } catch {
      return { folderKey: dir, dir, projectId: null, qaUrl: null }
    }
  }
  return { folderKey: dirs.at(-1)!, dir: null, projectId: null, qaUrl: null }
}

/** The project last seen in this folder. Never one seen in another: a folder with no config has no project of its own to show. */
async function lastProject($: EngineInterface, folderKey: string): Promise<string | null> {
  const id = await $.store.get(`${LAST_PROJECT_PREFIX}${folderKey}`).catch(() => null)
  return typeof id === 'string' ? id : null
}

/** The project to act on: the one named, else the folder's nearest config's, else the last seen in this folder. */
async function resolveProjectId($: EngineInterface, named?: string | null): Promise<string | null> {
  if (named) return named
  const config = await readConfig($)
  return config.projectId ?? (await lastProject($, config.folderKey))
}

/**
 * A `/replayqa` argument: a project id, or a dashboard URL, which also names the QA server, such
 * as a PR preview's `https://pr-1--qa.netlify.app/projects/proj-x/test-runs/…`.
 */
function parseProjectArg(arg: string | undefined): { projectId?: string; server?: string } {
  if (!arg) return {}
  const projectId = /proj[-_][A-Za-z0-9_-]+/.exec(arg)?.[0]
  return { ...(projectId ? { projectId } : {}), ...(/^https?:\/\//.test(arg) ? { server: arg } : {}) }
}

/** The QA server a project is on when nothing named one: its config's `proxy.qa-url`, for the folder's project. */
async function configServer($: EngineInterface, projectId: string): Promise<string | undefined> {
  const config = await readConfig($)
  return config.qaUrl && config.projectId === projectId ? config.qaUrl : undefined
}

async function rememberProject($: EngineInterface, projectId: string): Promise<void> {
  const { folderKey } = await readConfig($)
  await $.store.set(`${LAST_PROJECT_PREFIX}${folderKey}`, projectId)
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
  if (overview.error && !needsProjectSignIn(overview)) $.ui.toast(`Replay QA: ${overview.error}`)
  return overview
}

async function unfollowProject($: EngineInterface, projectId: string): Promise<void> {
  await relayJson($, '/qa/follow', { projectId, on: false })
  state.overviews.delete(projectId)
  state.activeAt.delete(projectId)
}

// ----------------------------------------------------------------- sign-in

type Minted = { credential: string; qaUrl: string | null }

/**
 * A credential from the Replay QA MCP server the person signed in to, which signs the relay in; null when it
 * cannot give one, and everything then uses what it always has: REPLAY_QA_API_KEY, then `replayqa login`.
 * What comes back is a secret until it is exchanged: it goes to the relay, never to a log, a toast, a URL or argv.
 *
 * Call this only from a hook. The engine puts the call to the session's permission mode, and the `tool.check`
 * hook that allows it is skipped when the plugin's own code raised the call from outside a hook: from a
 * button, a timer or a loop the person would get a dialog about a tool they never asked for. So the relay,
 * once signed in, mints what each process needs itself.
 *
 * Being connected says nothing about being signed in: a server may list its tools to anyone and answer
 * 401 only to a call. And a server without the tool (production, until it ships) fails the same way for
 * someone signed in and someone not, so that case tells nobody to sign in: it would not help.
 */
async function mintCredential($: EngineInterface): Promise<Minted | null> {
  // A server's 401, as the engine words it ("needs you to sign in again"), not a server saying it has none to share.
  const asksForSignIn = (text: string) => /needs you to sign in|re-?authenticate|authentication required|unauthori[sz]ed|\b401\b/i.test(text)
  const ask = async (): Promise<Minted | null> => {
    let server = MCP_SERVER
    let refusedSignIn = false
    try {
      const connected = await $.mcp.connect(MCP_SERVER)
      if (connected.isConnected) server = connected.server
      else refusedSignIn = connected.reason === 'auth'
      // Refused or not, one the person added under this name (say, a PR preview's) answers below.
    } catch {}
    try {
      const { code_challenge } = await relayJson<{ code_challenge: string }>($, '/auth/challenge', {})
      const result = await $.mcp.call(server, MCP_CREDENTIAL_TOOL, { code_challenge })
      const text = result.content.find(block => block.type === 'text')?.text
      if (result.isError || !text) {
        // The engine answers a server's 401 as an errored result, and marks the server as needing a sign-in.
        state.mcpAnswer = asksForSignIn(text ?? '') ? 'needs-sign-in' : 'cannot-share'
        return null
      }
      const { credential, qa_url: qaUrl } = JSON.parse(text) as { credential?: unknown; qa_url?: unknown }
      if (typeof credential !== 'string' || !credential.startsWith('mcl_')) {
        state.mcpAnswer = 'cannot-share'
        return null
      }
      state.mcpAnswer = 'gave'
      return { credential, qaUrl: typeof qaUrl === 'string' ? qaUrl : null }
    } catch (err) {
      // Its words only decide what to tell the person: they stay out of the log, whatever came back.
      state.mcpAnswer = refusedSignIn || asksForSignIn(message(err)) ? 'needs-sign-in' : 'cannot-share'
      return null
    }
  }
  const tooSlow = $.clock.sleep(MINT_TIMEOUT_MS).then(() => {
    state.mcpAnswer ??= 'cannot-share'
    return null
  })
  return Promise.race([ask(), tooSlow])
}

/**
 * Gives the relay the MCP sign-in, which it exchanges and refreshes for itself. From a hook only (see
 * mintCredential). Lazily, so a session that never touches Replay QA mints nothing; `force` is a person's
 * command, who may just have signed in.
 */
function signRelayIn($: EngineInterface, { force = false }: { force?: boolean } = {}): Promise<void> {
  if (!state.relay) return Promise.resolve()
  if (state.signingIn) return state.signingIn
  if (!force && Date.now() - state.auth.askedAt < SIGN_IN_RETRY_MS) return Promise.resolve()
  state.signingIn = (async () => {
    const asked = await relayJson<{ mcp: { origin: string; expiresAt: number }[]; existing: boolean }>($, '/auth/status')
    state.auth = { ...asked, askedAt: Date.now() }
    if (asked.mcp.length) return
    const minted = await mintCredential($)
    if (!minted) return
    await relayJson($, '/auth/credential', { credential: minted.credential })
    const after = await relayJson<{ mcp: { origin: string; expiresAt: number }[]; existing: boolean }>($, '/auth/status')
    state.auth = { ...after, askedAt: Date.now() }
  })()
    .catch(err => {
      state.auth.askedAt = Date.now()
      $.ui.log(`replay-qa: sign-in: ${message(err)}`, { to: 'debug' })
    })
    .finally(() => { state.signingIn = null })
  return state.signingIn
}

/**
 * How the person is signed in, as the lists say it, and what to do when they are not: `replayqa login`
 * always works, and /mcp is offered only when the server has asked for a sign-in, as otherwise it would
 * change nothing.
 */
function signInLine(): string {
  if (state.auth.mcp.length) return 'Signed in through the replay-qa MCP server.'
  if (state.auth.existing) return 'Using your existing Replay sign-in.'
  if (state.mcpAnswer === 'needs-sign-in') return 'Not signed in: run /mcp and sign in to replay-qa, or run npx --yes replayqa@0.7.0 login.'
  return 'The live views and tunnels have no sign-in. Run npx --yes replayqa@0.7.0 login: the replay-qa MCP server cannot share its sign-in with them yet.'
}

/** Explicit API status wins; older relays may only provide the diagnostic text. */
function needsProjectSignIn(overview?: Overview): boolean {
  return overview?.authRequired ?? /No Replay QA sign-in|answered 401|authentication required/i.test(overview?.error ?? '')
}

/** CLI login opens the person's normal browser, never a popup in the headless dashboard. */
function loginInBrowser($: EngineInterface): Promise<void> {
  if (state.browserLogin) return state.browserLogin
  state.loginError = null
  state.browserLogin = (async () => {
    $.ui.invalidate('ui.render')
    const result = await $.process.run([...state.cli, 'login'], { cwd: state.cwd, timeoutMs: 300_000 })
    if (result.exitCode !== 0) throw new Error('Replay sign-in did not finish. Try again, or run /mcp and authenticate replay-qa.')
    const status = await relayJson<{ mcp: { origin: string; expiresAt: number }[]; existing: boolean }>($, '/auth/status')
    state.auth = { ...status, askedAt: Date.now() }
    if (!status.existing && !status.mcp.length) throw new Error('No usable Replay sign-in was saved. Run /mcp and authenticate replay-qa, then retry.')
    if (state.canvasProjectId) await showCanvas($, state.canvasProjectId)
    else await tellRelayFolder($)
  })().catch(() => {
    // Process failures may contain sensitive browser-auth output; show only a fixed diagnostic.
    state.loginError = 'Sign-in did not finish. Try again, or run /mcp and authenticate replay-qa, then retry.'
  }).finally(() => {
    state.browserLogin = null
    $.ui.invalidate('ui.render')
  })
  return state.browserLogin
}

async function openMcpSignIn($: EngineInterface): Promise<void> {
  state.loginError = null
  try {
    await $.command.run({ command: 'mcp', args: '' })
  } catch {
    state.loginError = 'Run /mcp, choose replay-qa and authenticate it. Then run /replayqa again.'
    $.ui.invalidate('ui.render')
  }
}

// ------------------------------------------------------------------ folder

/** The first line of what a failed `replayqa` said worth showing: npm's chatter and a stack trace are not. */
function cliFailure(stderr: string): string {
  const line = stderr.split('\n').map(text => text.trim()).find(text => text && !/^(?:npm (?:warn|notice)\b|at\s)/.test(text))
  return (line ?? 'it printed nothing').replace(/^(?:\w*Error:|npm error(?: code)?:?|error:)\s*/, '').slice(0, 300)
}

const cliIsMissing = (stderr: string) => /notarget|no matching version|ETARGET|E404|unknown command/i.test(stderr)
const cliIsOffline = (stderr: string) => /ENOTFOUND|EAI_AGAIN|ETIMEDOUT|ECONNREFUSED|ECONNRESET|network/i.test(stderr)

/** What the pane says when `replayqa detect` could not run, as a whole sentence. */
function whyNoDetection(stderr: string): string {
  if (cliIsMissing(stderr)) return `Detection isn't available yet: ${state.cli.at(-1)} isn't published.`
  if (cliIsOffline(stderr)) return 'Detection didn\'t run: npm could not be reached to get replayqa. Are you offline?'
  return `Detection didn't run: replayqa detect failed: ${cliFailure(stderr)}`
}

/** What `replayqa detect` says of the session's folder, or why it could not say. It reads files and runs nothing there. */
async function detectFolder($: EngineInterface, { apps = false } = {}): Promise<{ detection: Detection } | { why: string }> {
  const { cwd } = await sessionFolder($)
  let stdout: string
  try {
    const ran = await $.process.run([...state.cli, 'detect', ...(apps ? ['--apps'] : []), '--json'], { cwd, timeoutMs: CLI_TIMEOUT_MS })
    if (ran.exitCode !== 0) return { why: whyNoDetection(ran.stderr || ran.stdout) }
    stdout = ran.stdout
  } catch (err) {
    return { why: `Detection didn't run: replayqa could not be run: ${message(err)}` }
  }
  const [parsed] = jsonValues(stdout) as [Detection | undefined]
  return parsed && Array.isArray(parsed.projects) && Array.isArray(parsed.apps)
    ? { detection: parsed }
    : { why: "Detection didn't run: replayqa detect did not print what was expected." }
}

/** Tells the relay what the browser view of the folder shows. */
async function tellRelayFolder($: EngineInterface): Promise<void> {
  await relayJson($, '/qa/folder', {
    view: state.folderView, folder: state.detection, why: state.detectionWhy, error: state.folderError,
    signIn: signInLine(),
  }).catch(err => $.ui.log(`replay-qa: folder: ${message(err)}`, { to: 'debug' }))
}

async function refreshSummaries($: EngineInterface): Promise<void> {
  const { summaries } = await relayJson<{ summaries: Record<string, Summary> }>($, '/qa/folder')
  if (JSON.stringify(summaries) === JSON.stringify(state.summaries)) return
  state.summaries = summaries
  $.ui.invalidate('ui.render')
}

async function openPane($: EngineInterface, { focus = false } = {}): Promise<void> {
  await $.ui.open({ id: PANE, title: 'Replay QA', rows: 26, ...(focus ? { focus: true as const } : {}) })
}

/** Stops the dashboard screencast, if one runs, and forgets the viewport. */
async function leaveCanvas($: EngineInterface): Promise<void> {
  state.dashboardQueue?.queue.close()
  state.dashboardQueue = null
  const projectId = state.canvasProjectId
  state.canvasProjectId = null
  state.canvasError = null
  state.canvasPicture = null
  state.canvasAsked = null
  if (projectId) await relayJson($, `/canvas/${encodeURIComponent(projectId)}/view`, { on: false }).catch(() => {})
}

/** The pane on the folder's index or setup list, in the terminal and the browser. */
async function showFolder($: EngineInterface, view: 'index' | 'setup'): Promise<void> {
  await leaveCanvas($)
  state.paneView = 'folder'
  state.folderView = view
  state.folderBusy = null
  await tellRelayFolder($)
  await openPane($, { focus: true })
  if (view === 'index') void refreshSummaries($).catch(() => {})
  $.ui.invalidate('ui.render')
}

const projectList = (projects: DetectedProject[]) => projects.map(p => `- ${p.project_id} (${p.path === '.' ? 'this folder' : p.path})`).join('\n')

/**
 * `/replayqa` from the session's folder: one project opens its dashboard, several the index, none the list to
 * set one up. With no detection, the nearest config stands in for it, and the pane says why.
 */
async function openFolder($: EngineInterface, { apps = false } = {}): Promise<string> {
  const config = await readConfig($)
  state.folderName = config.folderKey.split('/').pop() || config.folderKey
  state.folderError = null
  state.confirm = null
  // While detection runs (npx can take a while the first time) the pane says so.
  await leaveCanvas($)
  state.paneView = 'folder'
  state.folderBusy = 'Looking at this folder…'
  await openPane($)
  $.ui.invalidate('ui.render')

  const found = await detectFolder($, { apps })
  state.folderBusy = null
  state.detection = 'detection' in found ? found.detection : null
  state.detectionWhy = 'why' in found ? found.why : null
  const projects = state.detection?.projects ?? []

  if (!apps) {
    if (projects.length > 1) {
      await showFolder($, 'index')
      return `${projects.length} Replay QA projects in ${state.detection!.name}. Choose one in the pane, or /replayqa canvas <project id>:\n${projectList(projects)}`
    }
    const only = projects[0]
    const projectId = only?.project_id ?? config.projectId ?? (await lastProject($, config.folderKey))
    if (projectId) {
      await showCanvas($, projectId, only?.qa_url ?? (config.projectId === projectId ? config.qaUrl : null) ?? undefined)
      // No config names it: it is here only because it was the last one used in this folder, so that is said.
      state.canvasNote = only || config.projectId === projectId ? null : 'This is the last project used in this folder: no .replay/config.json names one. /replayqa setup shows what else is here.'
      const o = state.overviews.get(projectId)
      if (needsProjectSignIn(o)) return 'Sign in to Replay QA in the project pane. Connect the replay-qa MCP server, or choose Sign in with browser.'
      return [
        `Replay QA dashboard for ${o?.project?.name ?? projectId}: ${o?.counts.live ?? 0} live, ${o?.counts.journeys ?? 0} journeys. Running work streams in as it starts.`,
        state.canvasNote ?? '',
        state.detectionWhy ?? '',
        o?.error ? `It could not be read: ${o.error}` : '',
        state.canvasError ? `It has no picture: ${state.canvasError}` : '',
      ].filter(Boolean).join('\n')
    }
  }

  await showFolder($, 'setup')
  const name = state.detection?.name ?? state.folderName
  if (!state.detection) return `No .replay/config.json names a Replay QA project for ${name}. ${state.detectionWhy} The pane offers linking an existing project (/replayqa use <project>) and testing a public URL (/replayqa test <url>).`
  const listed = state.detection.apps.map(app => `${app.name} (${app.path})`).join(', ')
  if (!state.detection.apps.length) return `No Replay QA project in ${name}, and nothing here looks like an app to start. /replayqa use <project> links an existing project, and /replayqa test <url> tests a public URL.`
  return `${projects.length ? `Apps in ${name}` : `No Replay QA project in ${name} yet. Apps found`}, as suggestions to confirm: ${listed}. Their commands are in the pane. /replayqa start <path> starts one, /replayqa use <project> links an existing project, /replayqa test <url> tests a public URL.`
}

function findApp(ref: string): DetectedApp | undefined {
  return state.detection?.apps.find(app => app.setup?.cwd === ref || app.path === ref || app.name === ref)
}

/** Asks before starting: the command runs on this machine and testing uses QA credits. */
async function askToStart($: EngineInterface, app: DetectedApp): Promise<void> {
  if (!app.setup) return
  const key = app.setup.cwd
  state.confirm = { key, isBusy: false }
  state.folderError = null
  $.ui.invalidate('ui.render')
  if (!app.port) return
  const { isOpen } = await relayJson<{ isOpen: boolean }>($, `/ports/${app.port}`)
  if (state.confirm?.key !== key) return
  state.confirm = { key, isBusy: isOpen }
  $.ui.invalidate('ui.render')
}

/** Starts an app and its tunnel, under the relay, which gives it a credential of its own. `noApp` connects what already runs. */
async function startApp($: EngineInterface, app: DetectedApp, noApp = false): Promise<Tunnel> {
  if (!app.setup) throw new Error(`No command to start ${app.name} was found.`)
  const args = noApp
    ? [...app.setup.args.filter((arg, i, all) => arg !== '--app-command' && all[i - 1] !== '--app-command'), '--no-app']
    : app.setup.args
  const tunnel = await relayJson<Tunnel>($, '/tunnels', { key: app.setup.cwd, label: app.name, args, cwd: app.setup.cwd, targetUrl: app.setup.target_url })
  state.confirm = null
  state.tunnels = [...state.tunnels.filter(t => t.key !== tunnel.key), tunnel]
  $.ui.invalidate('ui.render')
  return tunnel
}

async function stopTunnel($: EngineInterface, key: string): Promise<void> {
  await relayJson($, `/tunnels/${encodeURIComponent(key)}/stop`, {})
}

/** Links the folder through the CLI; if it cannot run (not published yet, offline), writes the same file itself. */
async function linkProject($: EngineInterface, value: string, projectId: string): Promise<void> {
  const { cwd, dirs } = await sessionFolder($)
  let stderr = ''
  try {
    const ran = await $.process.run([...state.cli, 'link', value], { cwd, timeoutMs: CLI_TIMEOUT_MS })
    if (ran.exitCode === 0) return
    stderr = ran.stderr || ran.stdout
  } catch (err) {
    stderr = `ETIMEDOUT ${message(err)}`
  }
  if (!cliIsMissing(stderr) && !cliIsOffline(stderr)) throw new Error(cliFailure(stderr))
  const config = await readConfig($)
  let dir = config.dir
  for (const candidate of dirs) {
    if (dir) break
    if (await $.fs.exists(`${candidate}/package.json`)) dir = candidate
  }
  dir ??= dirs.at(-1)!
  let current: Record<string, unknown> = {}
  try {
    current = JSON.parse(await $.fs.read(`${dir}/.replay/config.json`)) as Record<string, unknown>
  } catch {}
  const existing = current['qa-project-id']
  if (typeof existing === 'string' && existing.trim() && existing.trim() !== projectId) {
    throw new Error(`.replay/config.json already contains qa-project-id ${existing.trim()}; not overwriting it with ${projectId}.`)
  }
  const origin = /^https?:\/\//.test(value) ? new URL(value).origin : null
  const proxy = origin && origin !== 'https://qa.replay.io' ? { proxy: { ...(current.proxy as object | undefined), 'qa-url': origin } } : {}
  await $.fs.write(`${dir}/.replay/config.json`, `${JSON.stringify({ ...current, 'qa-project-id': projectId, ...proxy }, null, 2)}\n`)
}

/** "Use an existing project": writes `qa-project-id` for this folder and opens its dashboard. */
async function useProject($: EngineInterface, value: string): Promise<string> {
  const named = parseProjectArg(value)
  if (!named.projectId) throw new Error(`${value} is not a Replay QA project id (proj-…) or dashboard URL.`)
  await linkProject($, value, named.projectId)
  const found = await detectFolder($)
  if ('detection' in found) state.detection = found.detection
  await showCanvas($, named.projectId, named.server ?? (await configServer($, named.projectId)))
  return `This folder now uses Replay QA project ${named.projectId}.`
}

/** "Test a public URL": creates a project for it, on a credential of its own, and opens its dashboard. */
async function testPublicUrl($: EngineInterface, value: string): Promise<string> {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new Error(`${value} is not a full URL: it needs its https://.`)
  }
  if (!/^https?:$/.test(url.protocol)) throw new Error(`${value} is not a web address.`)
  if (/^(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])$/.test(url.hostname)) {
    throw new Error(`${url.host} is on this machine, so Replay QA can't reach it without a tunnel: start the app from the list, or with replayqa run.`)
  }
  const minted = await relayJson<{ credential: string | null; qaUrl: string | null }>($, '/auth/mint', {}).catch(() => null)
  const { cwd } = await sessionFolder($)
  const ran = await $.process.run([...state.cli, 'bootstrap', url.toString(), '--public'], {
    cwd,
    timeoutMs: CLI_TIMEOUT_MS,
    ...(minted?.credential ? { env: { REPLAY_QA_API_KEY: minted.credential, ...(minted.qaUrl ? { REPLAY_QA_URL: minted.qaUrl } : {}) } } : {}),
  })
  // It prints the project first, so a project it made is opened even if what it asks next fails.
  const { projectId } = parseQaOutput(ran.stdout)
  if (!projectId) throw new Error(ran.exitCode === 0 ? 'replayqa bootstrap did not say which project it made.' : cliIsMissing(ran.stderr) ? `${state.cli.at(-1)} isn't published yet.` : cliFailure(ran.stderr))
  await showCanvas($, projectId, minted?.qaUrl ?? undefined)
  return `Replay QA is testing ${url.toString()} in project ${projectId}.`
}

/** A press, in the pane or the browser view: what it starts runs on, and what goes wrong shows in the pane. */
function act($: EngineInterface, busy: string | null, work: () => Promise<unknown>): void {
  state.folderBusy = busy
  state.folderError = null
  $.ui.invalidate('ui.render')
  void work()
    .catch(err => { state.folderError = message(err) })
    .finally(() => {
      state.folderBusy = null
      $.ui.invalidate('ui.render')
      if (state.paneView === 'folder') void tellRelayFolder($)
    })
}

/** A press in the browser view, which only the relay saw: checked here, as anything with the page's URL can post one. */
function handleFolderAction($: EngineInterface, action: Record<string, unknown>): void {
  const value = typeof action.value === 'string' ? action.value.trim() : ''
  const key = typeof action.key === 'string' ? action.key : ''
  if (action.type === 'start') {
    const app = findApp(key)
    if (app) act($, `Starting ${app.name}…`, () => startApp($, app, action.noApp === true))
  } else if (action.type === 'stop' && state.tunnels.some(t => t.key === key)) {
    act($, null, () => stopTunnel($, key))
  } else if (action.type === 'use' && value) {
    act($, `Linking ${value}…`, () => useProject($, value))
  } else if (action.type === 'test' && value) {
    act($, `Setting up ${value}…`, () => testPublicUrl($, value))
  }
}

/** A tunnel's project exists now: the folder has a project, and its dashboard is what to look at. */
async function projectFromTunnel($: EngineInterface, tunnel: Tunnel): Promise<void> {
  $.ui.toast(`Replay QA project ${tunnel.projectId} is set up for ${tunnel.label}.`)
  const found = await detectFolder($)
  if ('detection' in found) state.detection = found.detection
  if (state.paneView === 'folder') await showCanvas($, tunnel.projectId!, tunnel.qaUrl ?? undefined)
  else await followProject($, tunnel.projectId!, tunnel.qaUrl ?? undefined)
}

function updateTunnels($: EngineInterface, tunnels: Tunnel[]): void {
  const before = new Map(state.tunnels.map(t => [t.key, t]))
  if (JSON.stringify(tunnels) === JSON.stringify(state.tunnels)) return
  state.tunnels = tunnels
  for (const tunnel of tunnels) {
    if (tunnel.projectId && !before.get(tunnel.key)?.projectId) {
      void projectFromTunnel($, tunnel).catch(err => $.ui.log(`replay-qa: ${message(err)}`, { to: 'debug' }))
    }
  }
  $.ui.invalidate('ui.render')
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
      state.rowErrors.set(item.rowId, 'No test run started yet: the backend may still be queueing it. Open the dashboard to watch for it.')
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
  const startedExploration = parsed.explorationId && isRunningStatus(parsed.explorationStatus) && (!command || command.verb === 'start-exploration')
  const wantsFollow = Boolean(startedExploration || command?.startsRun || (command && ['status', 'full-qa', 'bootstrap'].includes(command.verb)))
  if (!wantsFollow) return
  const projectId = parsed.projectId ?? (await resolveProjectId($, command?.projectId))
  if (!projectId) {
    $.ui.log('replay-qa: no project id in the output, the arguments or .replay/config.json')
    return
  }
  const server = command?.server ?? parsed.qaUrl ?? (await configServer($, projectId))
  state.rowProjects.set(rowId, projectId)
  await signRelayIn($)
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
  if (state.canvasProjectId && state.canvasProjectId !== projectId) await leaveCanvas($)
  await followProject($, projectId, server)
  state.paneView = 'canvas'
  state.canvasProjectId = projectId
  state.canvasError = null
  state.canvasNote = null
  await openPane($)
  try {
    if (needsProjectSignIn(state.overviews.get(projectId))) {
      await relayJson($, `/canvas/${encodeURIComponent(projectId)}/view`, { on: false })
      $.ui.invalidate('ui.render')
      return
    }
    await relayJson($, `/canvas/${encodeURIComponent(projectId)}/view`, { on: true, width: 1600, height: 900 })
  } catch (err) {
    // No renderer: the pane says so, and the browser view still works.
    state.canvasError = message(err)
  }
  $.ui.invalidate('ui.render')
}

type DashboardInput = { type: string; [key: string]: unknown }
function browserQueue($: EngineInterface, projectId: string) {
  if (state.dashboardQueue?.projectId === projectId) return state.dashboardQueue.queue
  state.dashboardQueue?.queue.close()
  const queue = createDashboardQueue({
    sendInput: async (input: DashboardInput) => {
      if (state.canvasProjectId === projectId) await relayJson($, `/canvas/${encodeURIComponent(projectId)}/input`, input)
    },
    resize: async (view: { width: number; height: number }) => {
      if (state.canvasProjectId === projectId) await relayJson($, `/canvas/${encodeURIComponent(projectId)}/view`, { on: true, ...view })
    },
    onError: (err: unknown, kind: string) => {
      if (kind === 'resize' && state.canvasProjectId === projectId) state.canvasAsked = null
      $.ui.log(`replay-qa: dashboard ${kind}: ${message(err)}`, { to: 'debug' })
    },
  })
  state.dashboardQueue = { projectId, queue }
  return queue
}

function sendInput($: EngineInterface, input: DashboardInput): void {
  const projectId = state.canvasProjectId
  if (projectId) browserQueue($, projectId).push(input)
}

/** The screencast takes the pane picture's shape: updated in order with browser input when the pane changes. */
function sizeCanvas($: EngineInterface, projectId: string, columns: number, rows: number): void {
  const width = Math.max(640, Math.min(2400, Math.round(columns * 10)))
  const height = Math.max(240, Math.min(1600, Math.round((width * rows * CELL_ASPECT) / columns)))
  const asked = state.canvasAsked
  if (asked && asked.width === width && asked.height === height) return
  state.canvasAsked = { width, height }
  browserQueue($, projectId).resize({ width, height })
}

const fraction = (v: unknown, lo = 0, hi = 1) => (typeof v === 'number' && Number.isFinite(v) ? Math.max(lo, Math.min(hi, v)) : null)

// ---------------------------------------------------------------- watchers

/** Follows the relay's frame feed: blits new frames, parks ended streams, redraws on change. */
async function watchFrames($: EngineInterface): Promise<void> {
  const watcher = ++state.watcher
  let version = -1
  while (state.watcher === watcher && state.relay) {
    let snapshot: { version: number; frames: Record<string, FrameInfo>; tunnels?: Tunnel[]; actions?: Record<string, unknown>[] }
    try {
      snapshot = await relayJson($, `/frames?version=${version}`)
    } catch {
      await $.clock.sleep(1000)
      continue
    }
    version = snapshot.version
    if (snapshot.tunnels) updateTunnels($, snapshot.tunnels)
    for (const action of snapshot.actions ?? []) handleFolderAction($, action)
    let redraw = false
    // The interactive project gets its picture before background recording previews.
    const dashboardId = state.canvasProjectId ? canvasFrameId(state.canvasProjectId) : null
    const orderedFrames = Object.entries(snapshot.frames).sort(([a], [b]) => Number(b === dashboardId) - Number(a === dashboardId))
    for (const [id, fresh] of orderedFrames) {
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
    if (state.paneView === 'folder' && state.folderView === 'index') await refreshSummaries($).catch(() => {})
    for (const projectId of [...state.overviews.keys()]) {
      try {
        const before = state.overviews.get(projectId)
        const overview = await relayJson<Overview>($, `/qa/overview?project=${encodeURIComponent(projectId)}`)
        state.overviews.set(projectId, overview)
        if (state.canvasProjectId === projectId && needsProjectSignIn(before) && !needsProjectSignIn(overview)) {
          await showCanvas($, projectId)
        } else if (state.canvasProjectId === projectId && !needsProjectSignIn(before) && needsProjectSignIn(overview)) {
          await relayJson($, `/canvas/${encodeURIComponent(projectId)}/view`, { on: false })
        }
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
      } else if (key === OLD_LAST_PROJECT_KEY) {
        await $.store.delete(key)
      }
    }
    const cli = await $.env.get('REPLAY_QA_CLI').catch(() => undefined)
    state.cli = cli?.trim() ? cli.trim().split(/\s+/) : REPLAYQA
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
      description: "Replay QA for this folder: its project's dashboard of every journey, the index of its projects, or the list to set one up",
      argumentHint: '[login|canvas|setup|use|test|start|stop|follow|unfollow|live|open|status] [project id, dashboard URL, app path or recording]',
    })
    return started
  })

  // After the person's MCP panel closes, share its sign-in and retry the selected project.
  on('command.run', { command: 'mcp' }, async ($, e, next) => {
    const result = await next(e)
    if (state.relay && state.canvasProjectId && needsProjectSignIn(state.overviews.get(state.canvasProjectId))) {
      await signRelayIn($, { force: true })
      await showCanvas($, state.canvasProjectId)
    }
    return result
  })

  on('command.run', { command: 'replayqa' }, async ($, e) => {
    if (!state.relay) return { text: `The Replay QA relay is not running${state.relayError ? `: ${state.relayError}` : ''}.` }
    const [first = '', arg] = e.args.trim().split(/\s+/)
    // A project id or dashboard URL alone means its dashboard.
    const verb = parseProjectArg(first).projectId ? 'canvas' : first
    const named = parseProjectArg(parseProjectArg(first).projectId ? first : arg)
    try {
      if (verb === 'login') {
        void loginInBrowser($)
        await openPane($)
        return { text: 'Opening Replay sign-in in your browser. This pane refreshes when sign-in finishes.' }
      }
      // A person's command is a hook, so the MCP sign-in can reach the relay from here, and they may just have signed in.
      if (!['live', 'open', 'status'].includes(verb)) await signRelayIn($, { force: true })
      if (verb === '' || (verb === 'canvas' && !arg && !named.projectId)) return { text: await openFolder($) }
      if (verb === 'setup') return { text: await openFolder($, { apps: true }) }
      if (verb === 'use') {
        if (!arg) return { text: 'Pass the project: /replayqa use <project id or dashboard URL>.' }
        return { text: await useProject($, arg) }
      }
      if (verb === 'test') {
        if (!arg) return { text: 'Pass the address: /replayqa test <https://…>.' }
        return { text: await testPublicUrl($, arg) }
      }
      if (verb === 'stop') {
        const running = state.tunnels.filter(t => t.isRunning)
        const tunnel = arg ? running.find(t => t.key === arg || t.label === arg || t.key.endsWith(`/${arg}`)) : running.length === 1 ? running[0] : undefined
        if (!tunnel) return { text: running.length ? `Name one of these: ${running.map(t => t.label).join(', ')}.` : 'No tunnel is running.' }
        await stopTunnel($, tunnel.key)
        return { text: `Stopping ${tunnel.label}.` }
      }
      if (verb === 'start') {
        const found = await detectFolder($, { apps: true })
        if ('why' in found) return { text: found.why }
        state.detection = found.detection
        const app = arg ? findApp(arg) : found.detection.apps.length === 1 ? found.detection.apps[0] : undefined
        if (!app) return { text: `Name one of this folder's apps: ${found.detection.apps.map(a => a.path).join(', ') || 'none were found'}.` }
        const tunnel = await startApp($, app)
        return { text: `Starting ${tunnel.label} on ${tunnel.targetUrl}. It keeps running until /replayqa stop ${app.path} or the session ends.` }
      }
      if (verb === 'canvas' || verb === 'follow' || verb === 'unfollow') {
        const projectId = await resolveProjectId($, named.projectId)
        if (!projectId) return { text: 'This folder has no Replay QA project: /replayqa shows what is here, or pass a project id (proj-…) or dashboard URL.' }
        const server = named.server ?? (await configServer($, projectId))
        if (verb === 'unfollow') {
          await unfollowProject($, projectId)
          updateStatusLine($)
          return { text: `No longer following ${projectId}.` }
        }
        if (verb === 'canvas') {
          await showCanvas($, projectId, server)
          const o = state.overviews.get(projectId)
          if (needsProjectSignIn(o)) return { text: 'Sign in to Replay QA in the project pane. Connect the replay-qa MCP server, or choose Sign in with browser.' }
          return { text: `Replay QA dashboard for ${o?.project?.name ?? projectId}: ${o?.counts.live ?? 0} live, ${o?.counts.journeys ?? 0} journeys. Running work streams in as it starts.` }
        }
        const o = await followProject($, projectId, server)
        return { text: `Following ${o.project?.name ?? projectId}: ${o.counts.live} live. Running explorations and test runs stream into the dashboard (/replayqa canvas).` }
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
      if (verb === 'status') {
        const followed = [...state.overviews.values()]
        if (followed.length === 0) return { text: 'Nothing is being followed. /replayqa shows what is in this folder.' }
        return { text: `Following ${followed.map(o => `${o.project?.name ?? '?'} (${o.counts.live} live, ${o.counts.journeys} journeys, ${o.counts.bugs} with bugs)`).join('; ')}. /replayqa canvas shows them all.` }
      }
      return { text: `Unknown: ${first}. Try /replayqa, or /replayqa canvas|setup|use|test|start|stop|follow|unfollow|live|open|status.` }
    } catch (err) {
      return { text: `Replay QA: ${message(err)}` }
    }
  })

  // Browser input and
  // a player row's seek bar. Validated: it is client input.
  on('ui.message', async ($, e, next) => {
    // `e.module` is the path under the plugin's folder (`hooks/browser.tsx`); the `./` form is the Client's own.
    const module = e.module.replace(/^(?:\.\/|hooks\/)/, '')
    if (module === 'scrubber.tsx') {
      const row = state.rows.get(e.requestId)
      const data = e.data as { type?: string; ms?: number }
      if (row && (data.type === 'seek' || data.type === 'seekBy' || data.type === 'toggle')) await play($, row.recordingId, data.type, data.ms)
      return next(e)
    }
    if (module !== 'browser.tsx' || e.requestId !== PANE) return next(e)
    const data = (e.data ?? {}) as Record<string, unknown>
    if (data.type === 'batch') sendInput($, data as DashboardInput)
    return next(e)
  })

  // Scroll the dashboard under the pointer instead of the enclosing terminal pane.
  on('ui.scroll', { component: 'Pane', requestId: PANE }, async ($, e, next) => {
    const picture = state.canvasPicture
    const p = e.pointer
    if (!picture || !p || e.origin.kind !== 'person') return next(e)
    const row = p.row - picture.top
    if (row < 0 || row >= picture.rows || p.column < 0 || p.column >= picture.columns) return next(e)
    sendInput($, { type: 'wheel', deltaY: Math.max(-1000, Math.min(1000, e.by * 40)), x: (p.column + 0.5) / picture.columns, y: (row + 0.5) / picture.rows })
    return { deny: 'the dashboard scrolled instead' }
  })

  // `$.mcp.call` is put to the session's permission mode like any tool call, and nobody can answer for a press or a
  // background sign-in: refused, the sign-in would silently never work outside auto mode. This plugin's own mint is
  // allowed, by this; the model calling the tool itself asks as it would.
  on('tool.check', { tool: /^mcp__.*replay[-_]?qa.*__create_cli_credential$/ }, ($, e, next) =>
    next.origin.plugin === $.plugin.name ? { decision: 'allow' as const } : next(e))

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
          {state.canvasProjectId === null && state.rowProjects.get(id) ? <Button key="canvas" label="Open dashboard" onPress={() => { void showCanvas($, state.rowProjects.get(id)!) }} /> : null}
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
            <Button key="canvas" label="Show dashboard pane" onPress={() => { void showCanvas($, row.projectId) }} />
            <Button key="open-canvas" label="Open dashboard" onPress={() => openUrl($, canvasPage(row.projectId))} />
            <Button key="open" label="Open in browser" onPress={() => openUrl($, playerPage(row.recordingId))} />
          </Box>
        ) : null}
      </Box>
    )
  })

  // The dashboard pane: every journey of the project as rrweb players, as one picture.
  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const projectId = state.canvasProjectId
    const { Box, Text, Button } = $.ui.resolve(e)
    if (state.paneView === 'folder') {
      const data: FolderData = {
        view: state.folderView, name: state.folderName, detection: state.detection, why: state.detectionWhy, busy: state.folderBusy,
        error: state.folderError, summaries: state.summaries, tunnels: state.tunnels, confirm: state.confirm, signIn: signInLine(),
      }
      const actions: FolderActions = {
        openProject: project => act($, null, () => showCanvas($, project.project_id, project.qa_url ?? undefined)),
        askToStart: app => act($, null, () => askToStart($, app)),
        start: (app, noApp) => act($, `Starting ${app.name}…`, () => startApp($, app, noApp)),
        cancelStart: () => { state.confirm = null; $.ui.invalidate('ui.render') },
        stop: tunnel => act($, null, () => stopTunnel($, tunnel.key)),
        openTunnel: tunnel => act($, null, () => showCanvas($, tunnel.projectId!, tunnel.qaUrl ?? undefined)),
        copy: text => {
          void $.ui.copy({ text, surface: e.surface }).then(copied => $.ui.toast(copied.isCopied ? 'Copied.' : 'Could not copy here: select the command instead.'))
        },
        use: value => act($, `Linking ${value}…`, () => useProject($, value)),
        test: value => act($, `Setting up ${value}…`, () => testPublicUrl($, value)),
        openInBrowser: () => openUrl($, folderPage()),
        close: () => { void $.ui.close({ id: PANE }) },
      }
      const table = $.ui.resolve(e) as unknown as Required<FolderUi>
      // A table may hold an element its surface does not draw: `mobile` has no field to type in.
      const ui: FolderUi = { Box: table.Box, Text: table.Text, Button: table.Button, ...(e.surface === 'mobile' ? {} : { Input: table.Input }) }
      return drawFolder(ui, data, actions)
    }
    if (!projectId) return <Text dimColor>No project: run /replayqa for this folder, or /replayqa canvas &lt;project id&gt;.</Text>
    const overview = state.overviews.get(projectId)
    if (needsProjectSignIn(overview)) {
      state.canvasPicture = null
      state.mounted.delete(PANE)
      return (
        <Box flexDirection="column" gap={1}>
          <Text bold>Sign in to Replay QA</Text>
          <Text wrap="wrap">Connect the replay-qa MCP server to view this project. The separate server named replay is for recording and debugging.</Text>
          <Text wrap="wrap">Choose replay-qa in the MCP menu and authenticate. If that connection is unavailable, use Sign in with browser.</Text>
          {state.browserLogin ? <Text>Waiting for sign-in in your browser…</Text> : null}
          {state.loginError ? <Text color="red" wrap="wrap">{state.loginError}</Text> : null}
          <Box flexDirection="row" gap={1} flexWrap="wrap">
            <Button key="sign-in-mcp" label="Connect Replay QA" onPress={() => openMcpSignIn($)} />
            <Button key="sign-in-browser" label="Sign in with browser" onPress={() => { void loginInBrowser($) }} />
            <Button key="retry-auth" label="Retry" onPress={() => { void $.command.run({ command: 'replayqa', args: `canvas ${projectId}` }).catch(() => {}) }} />
            <Button key="open" label="Open in browser" onPress={() => openUrl($, canvasPage(projectId))} />
            <Button key="close" label="Close" onPress={() => { void $.ui.close({ id: PANE }) }} />
          </Box>
        </Box>
      )
    }
    const frame = state.frames[canvasFrameId(projectId)]
    const bodyRows = e.props.scroll.bodyRows > 0 ? e.props.scroll.bodyRows : Math.max(8, (e.viewport?.rows ?? 30) - 8)
    // The picture is the dashboard, filling the pane between the header line and the footer line;
    // the screencast is asked for that shape, so nothing is letterboxed.
    const columns = Math.max(20, Math.min(MAX_CELLS, e.props.bodyColumns > 0 ? e.props.bodyColumns : (e.viewport?.columns ?? 100)))
    // What went wrong is a row of its own, wrapped: inside the picture it is too small to read, and in the
    // footer it is cut off, and the server it names is what the person needs to see.
    const problem = overview?.error ?? state.canvasError
    const whyLine = state.detectionWhy
    const linesOf = (text: string | null | undefined) => (text ? Math.ceil((text.length + 2) / columns) : 0)
    const rows = Math.max(6, bodyRows - 2 - linesOf(problem) - linesOf(whyLine) - linesOf(state.canvasNote))
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
      ? <Text dimColor>The dashboard draws in the terminal; open it in a browser with the button below.</Text>
      : frame && frame.generation > 0
        ? (() => {
            state.mounted.set(PANE, { columns, rows, width, height })
            state.canvasPicture = { top: 1, columns, rows }
            sizeCanvas($, projectId, columns, rows)
            const { Image, Client } = $.ui.resolve(e)
            return (
              <Box key="stage" width={columns} height={rows}>
                <Image key={CANVAS_KEY} source={imageSource(frame)} columns={columns} rows={rows} alt={`Replay QA dashboard for ${name}`} />
                <Box position="absolute" top={0} left={0} width={columns} height={rows}>
                  <Client key="browser" module="./browser.tsx" width={columns} height={rows} props={{}} />
                </Box>
              </Box>
            )
          })()
        : problem ? null : <Text dimColor>Loading the dashboard…</Text>
    const tunnel = state.tunnels.find(t => t.isRunning && t.projectId === projectId)
    const hasIndex = (state.detection?.projects.length ?? 0) > 1
    return (
      <Box flexDirection="column">
        {header}
        {problem ? <Text color="red" wrap="wrap">⚠ {problem}</Text> : null}
        {whyLine ? <Text color="yellow" wrap="wrap">{whyLine}</Text> : null}
        {state.canvasNote ? <Text dimColor wrap="wrap">{state.canvasNote}</Text> : null}
        {picture}
        <Box flexDirection="row" gap={1} height={1} overflow="hidden">
          <Button key="open" label="Open in browser" onPress={() => openUrl($, canvasPage(projectId))} />
          {hasIndex ? <Button key="projects" label="Projects" onPress={() => act($, null, () => showFolder($, 'index'))} /> : null}
          {tunnel ? <Button key="stopTunnel" label="Stop tunnel" onPress={() => act($, null, () => stopTunnel($, tunnel.key))} /> : null}
          <Button key="close" label="Close" onPress={() => { void $.ui.close({ id: PANE }) }} />
          <Text dimColor wrap="truncate-end">{tunnel ? `${tunnel.text} ` : ''}click to interact · scroll to browse</Text>
        </Box>
      </Box>
    )
  })

  on('ui.close', { id: PANE }, async ($, e, next) => {
    const closed = await next(e)
    await leaveCanvas($)
    return closed
  })
}
