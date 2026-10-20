import { expect, mock, test } from 'claude-code/testing'

// The canvas pane with the relay faked beneath the plugin: its process prints where it listens and
// stays up, and its HTTP answers come from here. What the camera layer does arrives as the bodies
// of the relay's /camera calls.

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
    if (url.pathname.endsWith('/camera')) { camera.push(body); return answer({ result: 1 }) }
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
  on('ui.invalidate', () => ({ value: undefined }))
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
  await ui.resize({ columns: 80, rows: 22, in: 'camera' })
  return { ui, clock, camera, views }
}

test('the pane is the canvas: the picture fills it and the screencast takes its shape', async ($, on) => {
  const { ui, views } = await openCanvas($, on)
  expect(await ui.find({ type: 'Text', text: /scroll to zoom/ })).toBeTruthy()
  // 80 x 22 cells at about 2.1 cells tall per cell wide: the screencast is asked for that shape.
  const resized = views.find(v => v.width === 1600 && v.height !== 900)
  expect(resized?.height).toBe(Math.round((1600 * 22 * 2.1) / 80))
  await ui.unmount()
})

test('dragging over the picture pans the canvas by the distance moved, once', async ($, on) => {
  const { ui, clock, camera } = await openCanvas($, on)
  await act(ui, 'pointer', { type: 'down', x: 20, y: 10, button: 'left', in: 'camera' })
  await act(ui, 'pointer', { type: 'move', x: 30, y: 10, button: 'left', in: 'camera' })
  await act(ui, 'pointer', { type: 'move', x: 40, y: 5, button: 'left', in: 'camera' })
  await act(ui, 'pointer', { type: 'up', x: 40, y: 5, button: 'left', in: 'camera' })
  await clock.settle()
  const pans = camera.filter(c => c.op === 'pan')
  expect(pans.length).toBeGreaterThan(0)
  const total = pans.reduce((sum, p) => ({ dx: sum.dx + (p.dx as number), dy: sum.dy + (p.dy as number) }), { dx: 0, dy: 0 })
  expect(Math.abs(total.dx - 20 / 80) < 1e-9).toBe(true)
  expect(Math.abs(total.dy - -5 / 22) < 1e-9).toBe(true)
  await ui.unmount()
})

test('a double-click focuses the tile under it; keys zoom and fit', async ($, on) => {
  const { ui, clock, camera } = await openCanvas($, on)
  await act(ui, 'pointer', { type: 'down', x: 60, y: 4, button: 'left', in: 'camera' })
  await act(ui, 'pointer', { type: 'up', x: 60, y: 4, button: 'left', in: 'camera' })
  await act(ui, 'pointer', { type: 'down', x: 60, y: 4, button: 'left', in: 'camera' })
  await act(ui, 'pointer', { type: 'up', x: 60, y: 4, button: 'left', in: 'camera' })
  await act(ui, 'key', { key: '+', in: 'camera' })
  await act(ui, 'key', { key: '0', in: 'camera' })
  await clock.settle()
  expect(camera).toEqual([
    { op: 'focus', x: 60.5 / 80, y: 4.5 / 22 },
    { op: 'zoom', factor: 1.25 },
    { op: 'fit' },
  ])
  await ui.unmount()
})

test('the wheel over the picture zooms around the pointer instead of scrolling', async ($, on) => {
  const { ui, clock, camera } = await openCanvas($, on)
  const scrolled = await $.ui.scroll({
    component: 'Pane', requestId: 'replay-qa-canvas', offset: 0, by: -1, bodyRows: 24, contentRows: 24,
    origin: { kind: 'person' }, pointer: { column: 40, row: 12 },
  } as never)
  await clock.settle()
  expect(scrolled?.deny).toBeTruthy()
  expect(camera).toEqual([{ op: 'zoom', factor: 1.15, x: 40.5 / 80, y: 11.5 / 22 }])
  await ui.unmount()
})
