/* @jsx h */
import type { EngineInterface, Register } from 'claude-code'

import { closedSessions, openedSessions, parseBrowserCommands } from './detect.ts'
import { registerMcpCards } from './mcp/render.tsx'

// Inline Replay players: when Claude opens a Replay / playwright-cli browser
// from Bash, the relay injects Replay's tracer into the page, records the rrweb
// stream, and a headless renderer plays it into PNG frames that this module
// shows as an Image in place of that Bash call's result, live while the browser
// runs, then scrubbable (a seek bar, play/pause, ±10s) once it closes.
// Recordings are kept on disk, so the players stay in the transcript's
// scrollback across restarts, and Save video writes an .mp4 + .rrweb.json.

type Relay = { port: number; token: string; dataDir: string }

type RecordingInfo = {
  id: string
  session: string
  status: 'live' | 'ended'
  url: string | null
  eventCount: number
  durationMs: number
  startedAt: number
  lastError: string | null
  /** The Replay Chromium recordings made while the session ran (none in another browser). */
  replay: ReplayLink[]
}

type ReplayLink = {
  id: string
  uri: string | null
  recordingStatus: string | null
  uploadStatus: string | null
  url: string
}

type ExportJob = { status: 'running' | 'done' | 'failed'; progress: number; files: string[]; error: string | null }

type FrameInfo = {
  file: string
  generation: number
  width: number
  height: number
  mode: 'live' | 'replay'
  status: 'playing' | 'paused' | 'finished' | 'stopped'
  currentMs: number
  totalMs: number
  /** When `currentMs` was true, on the relay's clock (the same machine's). */
  at: number
  /** Bumped by every seek, play and pause. */
  seq: number
  recording: RecordingInfo | null
  export: ExportJob | null
}

type PlayerAction = 'play' | 'pause' | 'toggle' | 'seek' | 'seekBy' | 'replay' | 'stop'

type Player = { session: string; startedAt: number }

const IMAGE_KEY = 'player'
const STORE_PREFIX = 'player:'
const MAX_CELLS = 255
// A terminal cell is about twice as tall as it is wide.
const CELL_ASPECT = 2.1
const PLAYWRIGHT_CLI = ['npx', '--yes', '--package', '@playwright/cli', 'playwright-cli']

const state = {
  /** The session's working directory: where a Bash command runs unless it `cd`s. */
  cwd: null as string | null,
  relay: null as Relay | null,
  relayError: null as string | null,
  players: new Map<string, Player>(),
  frames: {} as Record<string, FrameInfo>,
  /** What each player's Image was last drawn with, so a frame of the same size can be blitted. */
  mounted: new Map<string, { columns: number; rows: number; width: number; height: number }>(),
  offscreen: new Set<string>(),
  watcher: 0,
}

const relayUrl = (path: string) => {
  const relay = state.relay
  if (!relay) throw new Error('the Replay live relay is not running')
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

/** Follows the relay's frame feed: blits new frames, redraws when a player changes shape. */
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
      if (!state.players.has(id)) continue
      const changedShape = !before
        || before.status !== fresh.status
        || before.mode !== fresh.mode
        || before.seq !== fresh.seq
        || before.totalMs !== fresh.totalMs
        || before.export?.status !== fresh.export?.status
        || Math.floor((before.export?.progress ?? 0) * 10) !== Math.floor((fresh.export?.progress ?? 0) * 10)
        || before.recording?.status !== fresh.recording?.status
        || before.recording?.lastError !== fresh.recording?.lastError
        || before.recording?.url !== fresh.recording?.url
      const mounted = state.mounted.get(id)
      const fits = mounted && mounted.width === fresh.width && mounted.height === fresh.height
      if (changedShape || !fits || before.generation === 0) {
        redraw = true
        continue
      }
      if (fresh.generation === before.generation || state.offscreen.has(id)) continue
      const blit = await $.ui.blit({ requestId: id, key: IMAGE_KEY, source: imageSource(fresh) })
      if (blit.deny) redraw = true
    }
    if (redraw) $.ui.invalidate('ui.render')
  }
}

function imageSource(frame: { file: string; generation: number }) {
  return { file: frame.file, format: 'png' as const, generation: frame.generation }
}

/** Injects the tracer into a session's browser and starts its live player. */
async function attach($: EngineInterface, id: string, session: string, cwd: string | null): Promise<void> {
  const { injectPath } = await relayJson<{ injectPath: string }>($, '/recordings', { id, session, cwd })
  // playwright-cli keeps a session per directory: inject from where the browser was opened.
  const injected = await $.process.run(
    [...PLAYWRIGHT_CLI, `--session=${session}`, 'run-code', '--filename', injectPath],
    { timeoutMs: 90_000, ...(cwd ? { cwd } : {}) },
  )
  if (injected.exitCode !== 0 || !injected.stdout.includes('Replay live tracer attached')) {
    await endSession($, session).catch(() => {})
    throw new Error(`tracer injection failed${cwd ? ` in ${cwd}` : ''}: ${(injected.stderr || injected.stdout).trim().slice(-300)}`)
  }
  const player: Player = { session, startedAt: Date.now() }
  state.players.set(id, player)
  await $.store.set(`${STORE_PREFIX}${id}`, player)
  await relayJson($, `/recordings/${encodeURIComponent(id)}/player`, { mode: 'live' })
  $.ui.status(`◉ Replay live: ${session}`)
  $.ui.invalidate('ui.render')
}

async function endSession($: EngineInterface, session: string): Promise<void> {
  await relayJson($, `/sessions/${encodeURIComponent(session)}/end`, {})
  $.ui.status(undefined)
}

async function play($: EngineInterface, id: string, mode: PlayerAction, ms?: number): Promise<void> {
  try {
    await relayJson($, `/recordings/${encodeURIComponent(id)}/player`, { mode, ms })
  } catch (err) {
    $.ui.toast(`Replay player: ${err instanceof Error ? err.message : String(err)}`)
  }
}

async function saveVideo($: EngineInterface, id: string): Promise<void> {
  try {
    await relayJson($, `/recordings/${encodeURIComponent(id)}/export`, {})
    $.ui.toast('Rendering the recording to .replay/live/…')
  } catch (err) {
    $.ui.toast(`Save video: ${err instanceof Error ? err.message : String(err)}`)
  }
}

async function uploadReplay($: EngineInterface, id: string): Promise<void> {
  $.ui.toast('Uploading the Replay recording…')
  try {
    const links = await relayJson<ReplayLink[]>($, `/recordings/${encodeURIComponent(id)}/replay/upload`, {})
    const done = links.filter(l => l.uploadStatus === 'uploaded')
    $.ui.toast(done.length ? `Uploaded: ${done.map(l => l.url).join('  ')}` : 'Nothing was uploaded.')
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    // Signed out, the relay opened Replay's browser sign-in: say what to do next.
    $.ui.toast(/^Sign in/.test(message) ? message : `Upload failed: ${message}`)
  }
}

/** Puts a prompt in the composer that hands the recording to Replay MCP. */
async function debugWithClaude($: EngineInterface, links: ReplayLink[], rec: RecordingInfo | null | undefined): Promise<void> {
  const ids = links.map(l => `${l.id} (${l.url})`).join(', ')
  const page = rec?.url ? ` of ${rec.url}` : ''
  const error = rec?.lastError ? ` The page reported: "${rec.lastError}".` : ''
  await $.prompt.fill({
    text: `Use the Replay MCP tools to debug the Replay recording ${ids} of the browser session${page}.${error} Start with RecordingOverview, then find the root cause.`,
  })
}

function openUrl($: EngineInterface, url: string): void {
  void $.process.run(['open', url]).catch(() => $.ui.toast(url))
}

function viewerUrl(id: string): string {
  return relayUrl(`/player/${encodeURIComponent(id)}?mode=auto&chrome=1`)
}

function headline(id: string, frame: FrameInfo | undefined): string {
  const rec = frame?.recording
  const session = rec?.session ?? state.players.get(id)?.session ?? 'browser'
  const where = rec?.url ? ` · ${rec.url}` : ''
  const events = rec ? ` · ${rec.eventCount.toLocaleString()} events` : ''
  if (rec?.status === 'live' && frame?.mode === 'live') return `◉ LIVE  ${session}${where}${events}`
  return `■ Replay recording  ${session}${where}${events}`
}

function exportLine(job: ExportJob | null | undefined): string | null {
  if (!job) return null
  if (job.status === 'running') return `Rendering video… ${Math.round(job.progress * 100)}%`
  if (job.status === 'failed') return `Save video failed: ${job.error ?? 'unknown error'}`
  return `Saved ${job.files.join('  ')}`
}

export const register: Register = on => {
  // Replay MCP tool results drawn as cards (hooks/mcp); screenshots go through the relay.
  registerMcpCards(on, () => (state.relay ? { base: `http://127.0.0.1:${state.relay.port}`, token: state.relay.token } : null))

  on('session.start', async ($, e, next) => {
    state.cwd = e.cwd
    const started = await next(e)
    for (const key of await $.store.keys()) {
      if (!key.startsWith(STORE_PREFIX)) continue
      const player = (await $.store.get(key)) as Player | undefined
      if (player) state.players.set(key.slice(STORE_PREFIX.length), player)
    }
    try {
      state.relay = await startRelay($)
      void watchFrames($)
    } catch (err) {
      state.relayError = err instanceof Error ? err.message : String(err)
      $.ui.log(`replayio: live relay did not start: ${state.relayError}`)
    }
    await $.command.register({
      name: 'replayio',
      description: 'Replay recordings: list them, open the library, or save one as video',
      argumentHint: '[library | save <session>]',
    })
    return started
  })

  on('command.run', { command: 'replayio' }, async ($, e) => {
    if (!state.relay) return { text: `The Replay live relay is not running${state.relayError ? `: ${state.relayError}` : ''}.` }
    const [verb, arg] = e.args.trim().split(/\s+/)
    if (verb === 'library') {
      openUrl($, relayUrl('/library'))
      return { text: `Opened the Replay library: ${relayUrl('/library')}` }
    }
    const recordings = await relayJson<RecordingInfo[]>($, '/recordings?all=1')
    if (verb === 'save') {
      const rec = recordings.find(r => !arg || arg === 'latest' || r.session === arg || r.id === arg)
      if (!rec) return { text: `No recording matches ${arg}.` }
      await saveVideo($, rec.id)
      return { text: `Saving \`${rec.session}\` as .mp4 + .rrweb.json under .replay/live/ (progress shows on its player).` }
    }
    if (recordings.length === 0) return { text: 'No Replay browser sessions recorded yet.' }
    const clock = (ms: number) => `${Math.floor(ms / 60000)}:${String(Math.round(ms / 1000) % 60).padStart(2, '0')}`
    const lines = recordings.slice(0, 20).map(r =>
      `- ${r.status === 'live' ? '◉ live' : '■'} ${new Date(r.startedAt).toLocaleString()} \`${r.session}\` ${clock(r.durationMs)} ${r.url ?? ''} — [play](${viewerUrl(r.id)})`)
    return { text: `Replay recordings (newest first; all of them in the library: /replayio library):\n${lines.join('\n')}` }
  })

  on('ui.message', async ($, e, next) => {
    if (e.module !== './scrubber.tsx' || !state.players.has(e.requestId)) return next(e)
    const data = e.data as { type?: string; ms?: number }
    if (data.type === 'seek' || data.type === 'seekBy' || data.type === 'toggle') await play($, e.requestId, data.type, data.ms)
    return next(e)
  })

  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const commands = parseBrowserCommands(e.command, state.cwd)
    if (commands.length === 0 || e.run_in_background) return next(e)
    const ran = await next(e)
    if (ran.deny !== undefined || ran.isError || !state.relay) return ran
    const output = ran.text ?? ''
    try {
      const open = commands.find(c => c.kind === 'open')
      const session = open ? (open.session ?? openedSessions(output)[0] ?? 'default') : null
      if (session) await attach($, e.tool_use_id, session, open?.cwd ?? state.cwd)
      for (const close of commands.filter(c => c.kind === 'close')) {
        for (const name of close.session ? [close.session] : closedSessions(output)) await endSession($, name)
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      $.ui.log(`replayio: live player: ${message}`)
      $.ui.toast(`Replay live player could not attach: ${message}`)
    }
    return ran
  })

  on('ui.render', { component: 'ToolResult' }, async ($, e, next) => {
    const id = e.requestId
    const player = state.players.get(id)
    if (!player || e.props.isErrored) return next(e)
    if (e.props.onScreen === null) state.offscreen.add(id)
    else state.offscreen.delete(id)

    const frame = state.frames[id]
    const ui = $.ui.resolve(e)
    const { Box, Text, Button } = ui
    const width = frame?.width ?? 1280
    const height = frame?.height ?? 720
    const columns = Math.max(20, Math.min(MAX_CELLS, (e.viewport?.columns ?? 100) - 6))
    const rows = Math.max(6, Math.min(48, Math.round((columns * height) / width / CELL_ASPECT)))

    // A saved last frame keeps the player in scrollback even before the relay draws again.
    const savedFrame = state.relay ? `${state.relay.dataDir}/frames/${id.replace(/[^A-Za-z0-9_.-]/g, '_')}.png` : null
    const source = frame && frame.generation > 0
      ? imageSource(frame)
      : savedFrame && (await $.fs.exists(savedFrame)) ? imageSource({ file: savedFrame, generation: 0 }) : null

    const isLive = frame?.recording?.status === 'live' && frame.mode === 'live'
    const isPlaying = frame?.status === 'playing' && frame.mode === 'replay'
    const lastError = frame?.recording?.lastError
    const saved = exportLine(frame?.export)
    const picture = !source
      ? <Text dimColor>{state.relay ? 'Waiting for the first frame…' : 'Replay live relay is not running.'}</Text>
      : e.surface === 'terminal'
        ? (() => {
            state.mounted.set(id, { columns, rows, width, height })
            const { Image } = $.ui.resolve(e)
            return <Image key={IMAGE_KEY} source={source} columns={columns} rows={rows} alt={`Replay of ${player.session}`} />
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
        <Text bold={isLive}>{headline(id, frame)}</Text>
        {picture}
        {scrubber}
        {lastError ? <Text color="red">⚠ {lastError}</Text> : null}
        {state.relay ? (
          <Box flexDirection="row" gap={1}>
            {isLive
              ? <Button key="replay" label="▶ Replay so far" onPress={() => play($, id, 'replay')} />
              : (
                <Box flexDirection="row" gap={1}>
                  <Button key="start" label="⏮" onPress={() => play($, id, 'seek', 0)} />
                  <Button key="back" label="−10s" onPress={() => play($, id, 'seekBy', -10_000)} />
                  <Button key="toggle" variant="primary" label={isPlaying ? '❚❚ Pause' : '▶ Play'} onPress={() => play($, id, isPlaying ? 'pause' : 'play')} />
                  <Button key="fwd" label="+10s" onPress={() => play($, id, 'seekBy', 10_000)} />
                </Box>
              )}
            <Button key="save" label="⤓ Save video" onPress={() => saveVideo($, id)} />
            <Button key="open" label="Open in browser" onPress={() => openUrl($, viewerUrl(id))} />
          </Box>
        ) : null}
        {(() => {
          const rec = frame?.recording
          if (!state.relay || !rec || rec.status === 'live') return null
          const links = rec.replay ?? []
          if (links.length === 0) return <Text dimColor>No Replay recording linked (the browser was not Replay Chromium recording).</Text>
          const isUploaded = links.every(l => l.uploadStatus === 'uploaded')
          return (
            <Box flexDirection="row" gap={1}>
              <Text>
                Replay recording {links.map(l => l.id.slice(0, 8)).join(', ')}
                <Text dimColor> · {isUploaded ? 'uploaded' : links.some(l => l.recordingStatus === 'recording') ? 'still recording' : 'not uploaded'}</Text>
              </Text>
              {isUploaded
                ? <Button key="replay-open" label="Open in Replay" onPress={() => openUrl($, links[0]?.url ?? '')} />
                : <Button key="replay-upload" label="⇪ Upload" onPress={() => uploadReplay($, id)} />}
              <Button key="replay-debug" variant="primary" label="Debug with Claude" onPress={() => debugWithClaude($, links, rec)} />
            </Box>
          )
        })()}
        {saved ? <Text dimColor={frame?.export?.status !== 'failed'} color={frame?.export?.status === 'failed' ? 'red' : undefined}>{saved}</Text> : null}
      </Box>
    )
  })
}
