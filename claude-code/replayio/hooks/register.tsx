/* @jsx h */
import type { EngineInterface, Register } from 'claude-code'

import { netEffect, openedSession, parseBrowserCommands, type BrowserCommand } from './detect.ts'

// The rrweb player in the transcript. Every agent-browser session runs in Replay Chromium, and
// the relay (live/relay.mjs) injects an rrweb recorder into each of its pages and appends the
// stream to a .rrweb file. A headless renderer plays that stream into PNG frames, which this
// module draws as an Image on the row that started it: live while the browser runs, scrubbable
// once it closes. The play_recording tool puts any recording already on disk on its own row.

type Relay = { port: number; token: string; dataDir: string; recordingsDir: string }

type RecordingInfo = {
  id: string
  session: string
  status: 'live' | 'ended'
  url: string | null
  file: string
  eventCount: number
  durationMs: number
  startedAt: number
  lastError: string | null
}

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
}

type PlayerAction = 'live' | 'replay' | 'play' | 'pause' | 'toggle' | 'seek' | 'seekBy' | 'stop'

/** A transcript row (its tool_use_id is the key) that holds a player. */
type Row = { session: string; recordingId: string; startedAt: number }

const IMAGE_KEY = 'player'
const STORE_PREFIX = 'player:'
const MAX_CELLS = 255
// A terminal cell is about twice as tall as it is wide.
const CELL_ASPECT = 2.1
const PLAY_TOOL = 'mcp__replayio__play_recording'
const CHROMIUM_PATHS = ['.replay/runtimes/Replay-Chromium.app/Contents/MacOS/Chromium', '.replay/runtimes/chrome-linux/chrome']

const state = {
  /** The session's working directory: where a Bash command runs unless it `cd`s. */
  cwd: null as string | null,
  /** Browser session name -> the recording following it, until it closes. */
  live: new Map<string, string>(),
  relay: null as Relay | null,
  relayError: null as string | null,
  rows: new Map<string, Row>(),
  /** Recording id -> its latest frame. */
  frames: {} as Record<string, FrameInfo>,
  /** What each row's Image was last drawn with, so a frame of the same size can be blitted. */
  mounted: new Map<string, { columns: number; rows: number; width: number; height: number }>(),
  offscreen: new Set<string>(),
  watcher: 0,
}

const message = (err: unknown) => (err instanceof Error ? err.message : String(err))

const relayUrl = (path: string) => {
  const relay = state.relay
  if (!relay) throw new Error('the Replay rrweb relay is not running')
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

/** The machine's relay, started if it is not running. It outlives this session on purpose. */
async function ensureRelay($: EngineInterface): Promise<void> {
  const res = await $.process.run(['node', `${$.plugin.root}/live/rrweb.mjs`, 'ensure'], { timeoutMs: 30_000 })
  if (res.exitCode !== 0) throw new Error((res.stderr || res.stdout).trim().slice(-300))
  state.relay = JSON.parse(res.stdout) as Relay
  state.relayError = null
}

/** Sends every agent-browser this session starts to Replay Chromium, recording. */
async function useReplayChromium($: EngineInterface): Promise<void> {
  if (!(await $.env.get('AGENT_BROWSER_EXECUTABLE_PATH'))) {
    const home = await $.env.get('HOME')
    for (const relative of CHROMIUM_PATHS) {
      const path = `${home}/${relative}`
      if (!(await $.fs.exists(path))) continue
      await $.env.set('AGENT_BROWSER_EXECUTABLE_PATH', path)
      break
    }
  }
  if (!(await $.env.get('RECORD_ALL_CONTENT'))) await $.env.set('RECORD_ALL_CONTENT', '1')
  if (!(await $.env.get('RECORD_REPLAY_VERBOSE'))) await $.env.set('RECORD_REPLAY_VERBOSE', '1')
}

const rowsOf = (recordingId: string) => [...state.rows.entries()].filter(([, row]) => row.recordingId === recordingId).map(([id]) => id)

/** Follows the relay's frame feed: blits new frames, redraws when a player changes shape. */
async function watchFrames($: EngineInterface): Promise<void> {
  const watcher = ++state.watcher
  let version = -1
  while (state.watcher === watcher) {
    let snapshot: { version: number; frames: Record<string, FrameInfo> }
    try {
      snapshot = await relayJson($, `/frames?version=${version}`)
    } catch {
      // The relay exits when idle and another plugin's may have replaced it: find the current one.
      await $.clock.sleep(1000)
      await ensureRelay($).catch(err => { state.relayError = message(err) })
      version = -1
      continue
    }
    version = snapshot.version
    let redraw = false
    for (const [recordingId, fresh] of Object.entries(snapshot.frames)) {
      const before = state.frames[recordingId]
      state.frames[recordingId] = fresh
      if (fresh.recording?.status === 'ended' && state.live.get(fresh.recording.session) === recordingId) {
        state.live.delete(fresh.recording.session)
        $.ui.status(undefined)
      }
      const rows = rowsOf(recordingId)
      if (rows.length === 0) continue
      const changedShape = !before
        || before.status !== fresh.status
        || before.mode !== fresh.mode
        || before.seq !== fresh.seq
        || before.totalMs !== fresh.totalMs
        || before.recording?.status !== fresh.recording?.status
        || before.recording?.lastError !== fresh.recording?.lastError
        || before.recording?.url !== fresh.recording?.url
      for (const rowId of rows) {
        const mounted = state.mounted.get(rowId)
        const fits = mounted && mounted.width === fresh.width && mounted.height === fresh.height
        if (changedShape || !fits || before?.generation === 0) {
          redraw = true
          continue
        }
        if (fresh.generation === before.generation || state.offscreen.has(rowId)) continue
        const blit = await $.ui.blit({ requestId: rowId, key: IMAGE_KEY, source: imageSource(fresh) })
        if (blit.deny) redraw = true
      }
    }
    if (redraw) $.ui.invalidate('ui.render')
  }
}

function imageSource(frame: { file: string; generation: number }) {
  return { file: frame.file, format: 'png' as const, generation: frame.generation }
}

async function addRow($: EngineInterface, rowId: string, session: string, recordingId: string): Promise<void> {
  const row: Row = { session, recordingId, startedAt: Date.now() }
  state.rows.set(rowId, row)
  await $.store.set(`${STORE_PREFIX}${rowId}`, row)
}

/** The CDP endpoint of an agent-browser session, which the relay joins to inject the recorder. */
async function agentBrowserCdp($: EngineInterface, session: string): Promise<string> {
  const res = await $.process.run(['agent-browser', '--session', session, 'get', 'cdp-url'], { timeoutMs: 30_000 })
  const url = res.stdout.split('\n').map(line => line.trim()).find(line => /^wss?:\/\//.test(line))
  if (res.exitCode !== 0 || !url) throw new Error(`agent-browser has no browser for session ${session}: ${(res.stderr || res.stdout).trim().slice(-200)}`)
  return url
}

/** Records a session's browser and starts its live player on this row. Resolves its .rrweb file. */
async function attach($: EngineInterface, rowId: string, command: BrowserCommand, session: string): Promise<string> {
  const cdp = await agentBrowserCdp($, session)
  const { recording } = await relayJson<{ recording: RecordingInfo }>($, '/recordings', { id: rowId, session, cwd: command.cwd ?? state.cwd, cdp })
  await addRow($, rowId, session, recording.id)
  state.live.set(session, recording.id)
  await relayJson($, `/recordings/${encodeURIComponent(recording.id)}/player`, { mode: 'live' })
  $.ui.status(`◉ Replay live: ${session}`)
  $.ui.invalidate('ui.render')
  return recording.file
}

async function endSession($: EngineInterface, session: string): Promise<void> {
  state.live.delete(session)
  await relayJson($, `/sessions/${encodeURIComponent(session)}/end`, {})
  $.ui.status(undefined)
}

async function play($: EngineInterface, recordingId: string, mode: PlayerAction, ms?: number): Promise<void> {
  try {
    await relayJson($, `/recordings/${encodeURIComponent(recordingId)}/player`, { mode, ms })
  } catch (err) {
    $.ui.toast(`Replay player: ${message(err)}`)
  }
}

function openUrl($: EngineInterface, url: string): void {
  // The URL carries the relay's token: never put it in a toast or the transcript.
  void $.process.run(['open', url]).catch(() => $.ui.toast('Could not open the browser'))
}

const viewerUrl = (recordingId: string) => relayUrl(`/player/${encodeURIComponent(recordingId)}?mode=auto&chrome=1`)

function headline(row: Row, frame: FrameInfo | undefined): string {
  const rec = frame?.recording
  const where = rec?.url ? ` · ${rec.url}` : ''
  const events = rec ? ` · ${rec.eventCount.toLocaleString()} events` : ''
  const session = rec?.session ?? row.session
  if (rec?.status === 'live' && frame?.mode === 'live') return `◉ LIVE  ${session}${where}${events}`
  return `■ Replay recording  ${session}${where}${events}`
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    state.cwd = e.cwd
    const started = await next(e)
    await useReplayChromium($)
    for (const key of await $.store.keys()) {
      if (!key.startsWith(STORE_PREFIX)) continue
      const rowId = key.slice(STORE_PREFIX.length)
      const row = (await $.store.get(key)) as Partial<Row> | undefined
      // A row from before rows and recordings had separate ids.
      if (row?.session) state.rows.set(rowId, { session: row.session, recordingId: row.recordingId ?? rowId, startedAt: row.startedAt ?? 0 })
    }
    try {
      await ensureRelay($)
    } catch (err) {
      state.relayError = message(err)
      $.ui.log(`replayio: rrweb relay did not start: ${state.relayError}`)
    }
    void watchFrames($)
    await $.command.register({ name: 'replayio', description: 'List the rrweb recordings of your browser sessions' })
    await $.tool.register({
      name: 'play_recording',
      description: 'Plays an rrweb recording of a browser session in the conversation: live if it is still being made, otherwise from its start, with a seek bar. Every agent-browser session is recorded automatically and needs no call to start.',
      inputSchema: {
        type: 'object',
        properties: {
          recording: {
            type: 'string',
            description: '`latest` (the default), an agent-browser session name, a recording id, or the path of a .rrweb file.',
          },
        },
      },
      isDeferred: false,
    })
    return started
  })

  on('command.run', { command: 'replayio' }, async $ => {
    if (!state.relay) return { text: `The Replay rrweb relay is not running${state.relayError ? `: ${state.relayError}` : ''}.` }
    const recordings = await relayJson<RecordingInfo[]>($, '/recordings?all=1')
    if (recordings.length === 0) return { text: `No rrweb recordings yet. They are saved to ${state.relay.recordingsDir}.` }
    const clock = (ms: number) => `${Math.floor(ms / 60000)}:${String(Math.round(ms / 1000) % 60).padStart(2, '0')}`
    const lines = recordings.slice(0, 20).map(r =>
      `- ${r.status === 'live' ? '◉ live' : '■'} ${new Date(r.startedAt).toLocaleString()} \`${r.session}\` ${clock(r.durationMs)} ${r.url ?? ''}\n  \`${r.file}\``)
    return { text: `rrweb recordings, newest first. Ask Claude to play one here.\n${lines.join('\n')}` }
  })

  on('tool.call', { tool: PLAY_TOOL }, async ($, e) => {
    const wanted = (e.input as { recording?: string } | undefined)?.recording ?? 'latest'
    try {
      if (!state.relay) await ensureRelay($)
      const rec = await relayJson<RecordingInfo>($, `/resolve?ref=${encodeURIComponent(wanted)}`)
      await addRow($, e.tool_use_id, rec.session, rec.id)
      await relayJson($, `/recordings/${encodeURIComponent(rec.id)}/player`, { mode: rec.status === 'live' ? 'live' : 'replay' })
      $.ui.invalidate('ui.render')
      return { result: `Playing ${rec.status === 'live' ? 'the live recording' : 'the recording'} of ${rec.session}${rec.url ? ` (${rec.url})` : ''}: ${rec.eventCount} rrweb events from ${rec.file}.` }
    } catch (err) {
      return { deny: `Could not play ${wanted}: ${message(err)}` }
    }
  }).catch(() => ({ deny: 'The Replay rrweb player failed.' }))

  on('ui.message', async ($, e, next) => {
    // `e.module` is the path under the plugin's folder (`hooks/scrubber.tsx`); the `./` form is the Client's own.
    const row = state.rows.get(e.requestId)
    if (e.module.replace(/^(?:\.\/|hooks\/)/, '') !== 'scrubber.tsx' || !row) return next(e)
    const data = e.data as { type?: string; ms?: number }
    if (data.type === 'seek' || data.type === 'seekBy' || data.type === 'toggle') await play($, row.recordingId, data.type, data.ms)
    return next(e)
  })

  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    if (e.run_in_background) return next(e)
    const commands = netEffect(parseBrowserCommands(e.command, state.cwd))
    const ran = await next(e)
    if (commands.length === 0 || ran.deny !== undefined || ran.isError || !state.relay) return ran
    const context: string[] = []
    try {
      for (const command of commands) {
        const session = command.session ?? openedSession(ran.text ?? '')
        if (command.kind === 'close') {
          for (const name of command.all ? [...state.live.keys()] : session ? [session] : []) await endSession($, name)
          continue
        }
        if (!session || state.live.has(session)) continue
        context.push(`The browser session \`${session}\` is being recorded to ${await attach($, e.tool_use_id, command, session)}`)
      }
    } catch (err) {
      $.ui.log(`replayio: rrweb player: ${message(err)}`)
      $.ui.toast(`Replay rrweb recorder could not attach: ${message(err)}`)
    }
    return context.length > 0 ? { ...ran, context: [...(ran.context ?? []), ...context] } : ran
  }).catch(($, e, next) => next(e)) // The recorder must never stand in the way of the command.

  // The engine folds runs of shell commands into one "Ran N shell commands" line, and an
  // unfolded group draws each call as a ToolUse row with its output inline, so the player
  // is drawn on the call's own row, and any group that holds a player is unfolded.
  on('ui.render', { component: 'ToolGroup' }, ($, e, next) =>
    !e.props.isExpanded && e.props.calls.some(c => c.tool_use_id && state.rows.has(c.tool_use_id))
      ? next({ ...e, props: { ...e.props, isExpanded: true } })
      : next(e))

  // A standalone call's result block would repeat the player.
  on('ui.render', { component: 'ToolResult' }, ($, e, next) => {
    if (!state.rows.has(e.requestId) || e.props.isErrored) return next(e)
    const { Box } = $.ui.resolve(e)
    return <Box />
  })

  on('ui.render', { component: 'ToolUse' }, async ($, e, next) => {
    const rowId = e.requestId
    const row = state.rows.get(rowId)
    if (!row || e.props.isErrored) return next(e)
    if (e.props.onScreen === null) state.offscreen.add(rowId)
    else state.offscreen.delete(rowId)

    const id = row.recordingId
    const frame = state.frames[id]
    const rec = frame?.recording
    const { Box, Text, Button } = $.ui.resolve(e)
    const width = frame?.width ?? 1280
    const height = frame?.height ?? 720
    const columns = Math.max(20, Math.min(MAX_CELLS, (e.viewport?.columns ?? 100) - 6))
    const rows = Math.max(6, Math.min(48, Math.round((columns * height) / width / CELL_ASPECT)))

    // A saved last frame keeps the player in scrollback even before the relay draws again.
    const savedFrame = state.relay ? `${state.relay.dataDir}/frames/${id.replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 120)}.png` : null
    const source = frame && frame.generation > 0
      ? imageSource(frame)
      : savedFrame && (await $.fs.exists(savedFrame)) ? imageSource({ file: savedFrame, generation: 0 }) : null

    const isLive = rec?.status === 'live' && frame?.mode === 'live'
    const isPlaying = frame?.status === 'playing' && frame.mode === 'replay'
    const picture = !source
      ? <Text dimColor>{state.relay ? 'Waiting for the first frame…' : 'The Replay rrweb relay is not running.'}</Text>
      : e.surface === 'terminal'
        ? (() => {
            state.mounted.set(rowId, { columns, rows, width, height })
            const { Image } = $.ui.resolve(e)
            return <Image key={IMAGE_KEY} source={source} columns={columns} rows={rows} alt={`Replay of ${row.session}`} />
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
        <Text bold={isLive} wrap="truncate-end">{headline(row, frame)}</Text>
        {picture}
        {scrubber}
        {rec?.lastError ? <Text color="red">⚠ {rec.lastError}</Text> : null}
        {rec?.status === 'ended' && rec.eventCount === 0
          ? <Text color="yellow" wrap="wrap">No events were recorded: the page may not have loaded in this browser, or it blocked the recorder. Open the page over http://localhost or a real URL and try again.</Text>
          : null}
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
            <Button key="open" label="Open in browser" onPress={() => openUrl($, viewerUrl(id))} />
          </Box>
        ) : null}
        {rec?.file ? <Text dimColor wrap="truncate-start">{rec.file}</Text> : null}
      </Box>
    )
  })
}
