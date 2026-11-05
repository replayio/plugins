import { expect, mock, test } from 'claude-code/testing'

// The dashboard pane with a fake relay: verify browser input and viewport requests.

const PROJECT = 'proj-shop'
const FRAME = {
  file: '/tmp/replay-qa-canvas-test.png', generation: 1, width: 1600, height: 900, kind: 'canvas', mode: 'canvas',
  status: 'playing', currentMs: 0, totalMs: 0, at: 0, seq: 1, recording: null,
}
const OVERVIEW = {
  project: { id: PROJECT, name: 'Shop', target_url: null, status: 'active' }, server: null, error: null, updatedAt: 0,
  following: true, counts: { live: 1, journeys: 4, bugs: 0, failed: 0 }, tiles: [],
}


type Test = Parameters<typeof test>[1]
type Mounted = Awaited<ReturnType<typeof openCanvas>>['ui']

/** A pointer or key act, then a frame, which is when a Client's post is sent. */
async function act(ui: Mounted, kind: 'pointer' | 'key', event: any) {
  await (kind === 'pointer' ? ui.pointer(event) : ui.key(event))
  await ui.advance(20)
}

async function openCanvas($: Parameters<Test>[0], on: Parameters<Test>[1]) {
  const clock = mock.clock(on)
  mock.store(on)
  const camera: Record<string, unknown>[] = []
  const views: Record<string, unknown>[] = []
  const payloads: { events?: unknown[] }[] = []
  let framesServed = false

  on('process.spawn', async function* () {
    yield { stream: 'stdout' as const, text: '{"port":4000,"token":"t"}\n' }
    await clock.sleep(1e12)
    return { code: 0, signal: null }
  })
  on('http.fetch', (_, e) => {
    const url = new URL(e.url)
    const body = e.init?.body ? JSON.parse(String(e.init.body)) : undefined
    const answer = (value: unknown, status = 200) => ({ value: { status, ok: status < 300, headers: {}, text: JSON.stringify(value) } })
    if (url.pathname === '/qa/follow' || url.pathname === '/qa/overview') return answer(OVERVIEW)
    if (url.pathname.endsWith('/view')) { views.push(body); return answer(FRAME) }
    if (url.pathname.endsWith('/input')) { payloads.push(body); if (body.type !== 'batch') camera.push(body); for (const event of body.events ?? []) { if (!camera.some(c => c.seq === event.seq)) camera.push({ ...event.input, seq: event.seq }) } return answer({ ok: true }) }
    if (url.pathname === '/frames' && !framesServed) {
      framesServed = true
      return answer({ version: 1, frames: { [`canvas-${PROJECT}`]: FRAME } })
    }
    // Later long polls fail, so the watchers sleep on the mock clock, which never moves.
    return answer({ error: 'not here' }, 500)
  })
  on('fs.exists', () => ({ value: false }))
  on('command.register', () => ({ value: { command: 'replayqa' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.blit', () => ({ value: {} }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('command.run', () => ({ text: '' }))

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await clock.settle()
  await $.command.run({ command: 'replayqa', args: `canvas ${PROJECT}` })
  await clock.settle()

  const ui = await $.ui.mount({
    plugin: 'replay-qa',
    component: 'Pane',
    requestId: 'replay-qa-canvas',
    surface: 'terminal',
    props: { title: 'Replay QA', isFocused: true, bodyColumns: 80, placement: 'dock', scroll: { offset: 0, bodyRows: 24 }, view: {} },
  })
  await ui.resize({ columns: 80, rows: 22, in: 'browser' })
  // The moves the person made: the pane also asks for the camera's state as it draws and resizes.
  const moves = () => camera.filter(c => c.op !== 'state')
  /** The same, less the gestures every press sends (the page decides what a gesture does). */
  const others = () => moves().filter(c => c.op !== 'gesture')
  return { ui, clock, camera, views, moves, others, payloads }
}

test('the dashboard fills the pane and resizes its browser viewport', async ($, on) => {
  const { ui, views } = await openCanvas($, on)
  expect(await ui.find({ type: 'Text', text: /click to interact/ })).toBeTruthy()
  expect(views.some(v => v.width === 800 && v.height === 462)).toBe(true)
  await ui.unmount()
})

test('clicks and typing go to the dashboard instead of camera shortcuts', async ($, on) => {
  const { ui, clock, camera } = await openCanvas($, on)
  await act(ui, 'pointer', { type: 'down', x: 20, y: 10, button: 'left', in: 'browser' })
  await act(ui, 'pointer', { type: 'up', x: 20, y: 10, button: 'left', in: 'browser' })
  await act(ui, 'key', { key: '+', in: 'browser' })
  await act(ui, 'key', { key: '0', in: 'browser' })
  await clock.settle()
  expect(camera.map(({ seq, ...input }) => input)).toEqual([
    { type: 'pointer', event: 'down', button: 'left', x: 20.5 / 80, y: 10.5 / 22 },
    { type: 'pointer', event: 'up', button: 'left', x: 20.5 / 80, y: 10.5 / 22 },
    { type: 'key', key: '+' }, { type: 'key', key: '0' },
  ])
  await ui.unmount()
})

test('the wheel scrolls the dashboard under the pointer', async ($, on) => {
  const { ui, clock, camera } = await openCanvas($, on)
  const scrolled = await $.ui.scroll({
    component: 'Pane', requestId: 'replay-qa-canvas', offset: 0, by: -1, bodyRows: 24, contentRows: 24,
    origin: { kind: 'person' }, pointer: { column: 40, row: 12 },
  } as never)
  await clock.settle()
  expect(scrolled?.deny).toBeTruthy()
  expect(camera).toEqual([{ type: 'wheel', deltaY: -40, x: 40.5 / 80, y: 11.5 / 22 }])
  await ui.unmount()
})

test('a quick click within one client frame preserves both mouse events', async ($, on) => {
  const { ui, clock, camera } = await openCanvas($, on)
  await ui.pointer({ type: 'down', x: 20, y: 10, button: 'left', in: 'browser' })
  await ui.pointer({ type: 'up', x: 20, y: 10, button: 'left', in: 'browser' })
  await ui.advance(20)
  await clock.settle()
  expect(camera.map(c => c.event)).toEqual(['down', 'up'])
  await ui.unmount()
})


test('pointer history stays compact and retains the following click', async ($, on) => {
  const { ui, clock, camera, payloads } = await openCanvas($, on)
  for (let x = 0; x < 60; x++) await ui.pointer({ type: 'move', x, y: 10, in: 'browser' })
  await ui.pointer({ type: 'down', x: 59, y: 10, button: 'left', in: 'browser' })
  await ui.pointer({ type: 'up', x: 59, y: 10, button: 'left', in: 'browser' })
  await ui.advance(20)
  await clock.settle()
  expect(Math.max(...payloads.map(p => p.events?.length ?? 0))).toBeLessThanOrEqual(3)
  expect(camera.slice(-2).map(c => c.event)).toEqual(['down', 'up'])
  expect(camera.filter(c => c.event === 'move').at(-1)!.x).toBe(59.5 / 80)
  await ui.unmount()
})
