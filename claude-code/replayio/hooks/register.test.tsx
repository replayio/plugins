import { expect, mock, test } from 'claude-code/testing'

const RELAY = { port: 1, token: 't', dataDir: '/data', recordingsDir: '/data/recordings' }
const REC = { id: 'rec1', session: 'demo', status: 'ended', url: 'http://x/', file: '/data/recordings/a-demo-rec1.rrweb', eventCount: 12, durationMs: 5000, startedAt: 1, lastError: null }
const frame = (over: Record<string, unknown>) => ({
  file: '/data/frames/rec1.png', generation: 3, width: 1280, height: 720, mode: 'replay', status: 'paused',
  currentMs: 0, totalMs: 5000, at: 1, seq: 1, recording: REC, ...over,
})

/** The engine and the relay, as far as the plugin reaches them. */
function world(on: Parameters<Parameters<typeof test>[1]>[1], frames: Record<string, unknown>, stored: string[] = []) {
  const calls: string[] = []
  let polled = false
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('command.register', () => ({ value: { command: 'replayio' } }))
  on('tool.register', () => ({ value: { tool: 'mcp__replayio__play_recording' } }))
  on('fs.exists', () => ({ value: false }))
  on('env.get', () => ({ value: undefined }))
  on('env.set', () => ({ value: {} }))
  on('store.keys', () => ({ value: [] }))
  on('store.set', (_, e) => {
    stored.push(e.key)
    return { value: undefined }
  })
  on('ui.status', () => ({ value: undefined }))
  on('ui.log', () => ({ value: undefined }))
  on('ui.toast', () => ({ value: undefined }))
  on('process.run', (_, e) => ({ value: { exitCode: 0, stderr: '', stdout: e.argv.includes('ensure') ? JSON.stringify(RELAY) : 'ws://127.0.0.1/devtools\n' } }))
  on('http.fetch', async (_, e) => {
    const url = new URL(e.url)
    const method = e.init?.method ?? 'GET'
    calls.push(`${method} ${url.pathname}`)
    if (url.pathname === '/frames') {
      // The first poll answers; the rest wait, as a long poll does.
      if (polled) await new Promise(() => {})
      polled = true
      return { value: { ok: true, status: 200, text: JSON.stringify({ version: 1, frames: { rec1: frames } }) } }
    }
    const body = url.pathname === '/resolve' || url.pathname === '/recordings' && method !== 'POST' ? REC : { recording: { ...REC, status: 'live' } }
    return { value: { ok: true, status: 200, text: JSON.stringify(body) } }
  })
  return calls
}

const row = (requestId: string, surface: 'terminal' | 'desktop') => ({
  plugin: 'replayio', surface, component: 'ToolUse', requestId,
  props: { tool: 'mcp__replayio__play_recording', input: {}, isErrored: false, onScreen: {} },
  viewport: { columns: 100, rows: 40 },
}) as never

test('a historical recording plays on the tool row, and the row is only the player', async ($, on) => {
  const stored: string[] = []
  const calls = world(on, frame({}), stored)
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  const played = await $.tool.call({ tool: 'mcp__replayio__play_recording', input: { recording: 'demo' } } as never)
  expect((played as { result?: string }).result).toContain('a-demo-rec1.rrweb')
  expect(calls).toContain('POST /recordings/rec1/player')

  const rowId = stored[0]!.slice('player:'.length)
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount(row(rowId, surface))
    expect(await ui.find({ key: 'toggle' })).toBeDefined()
    expect(await ui.find({ key: 'open' })).toBeDefined()
    for (const gone of ['save', 'replay-upload', 'replay-debug']) expect(await ui.find({ key: gone })).toBeUndefined()
    await ui.unmount()
  }
})

test('a row with no player is the engine\'s', async ($, on) => {
  world(on, frame({}))
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>engine</Text>
  })
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  const ui = await $.ui.mount(row('someone-else', 'terminal'))
  expect((await ui.find({ type: 'Text' }))?.text).toBe('engine')
  await ui.unmount()
})

test('agent-browser commands record; other commands do not', async ($, on) => {
  const calls = world(on, frame({ mode: 'live', status: 'playing', recording: { ...REC, status: 'live' } }))
  on('tool.call', { tool: 'Bash' }, () => ({ result: {}, text: 'ok' }))
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  await $.tool.call({ tool: 'Bash', command: 'ls' })
  expect(calls).not.toContain('POST /recordings')
  await $.tool.call({ tool: 'Bash', command: 'agent-browser --session demo snapshot' })
  expect(calls).toContain('POST /recordings')
  expect(calls).toContain('POST /recordings/rec1/player')
  await $.tool.call({ tool: 'Bash', command: 'agent-browser --session demo close' })
  expect(calls).toContain('POST /sessions/demo/end')
})
