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

const MINIMAP = { x: 0.75, y: 0.7, w: 0.2, h: 0.25 }

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
    // The camera answers its state: a zoom, and the minimap in the picture's bottom-right corner.
    if (url.pathname.endsWith('/camera')) { camera.push(body); return answer({ result: { k: 1.5, minimap: MINIMAP } }) }
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
  await ui.resize({ columns: 80, rows: 22, in: 'camera' })
  // The moves the person made: the pane also asks for the camera's state as it draws and resizes.
  const moves = () => camera.filter(c => c.op !== 'state')
  /** The same, less the gestures every press sends (the page decides what a gesture does). */
  const others = () => moves().filter(c => c.op !== 'gesture')
  return { ui, clock, camera, views, moves, others }
}

test('the pane is the canvas: the picture fills it and the screencast takes its shape', async ($, on) => {
  const { ui, views } = await openCanvas($, on)
  expect(await ui.find({ type: 'Text', text: /scroll to zoom/ })).toBeTruthy()
  // 80 x 22 cells at about 2.1 cells tall per cell wide: the screencast is asked for that shape.
  const resized = views.find(v => v.width === 1600 && v.height !== 900)
  expect(resized?.height).toBe(Math.round((1600 * 22 * 2.1) / 80))
  await ui.unmount()
})

test('a drag reaches the page as one gesture, each post carrying all of it', async ($, on) => {
  const { ui, clock, moves } = await openCanvas($, on)
  await act(ui, 'pointer', { type: 'down', x: 20, y: 10, button: 'left', in: 'camera' })
  await act(ui, 'pointer', { type: 'move', x: 30, y: 10, button: 'left', in: 'camera' })
  await act(ui, 'pointer', { type: 'move', x: 40, y: 5, button: 'left', in: 'camera' })
  await act(ui, 'pointer', { type: 'up', x: 40, y: 5, button: 'left', in: 'camera' })
  await clock.settle()
  const gestures = moves()
  expect(gestures.every(g => g.op === 'gesture' && g.id === gestures[0]!.id && g.sx === 20.5 / 80 && g.sy === 10.5 / 22)).toBe(true)
  expect(gestures[0]).toEqual({ op: 'gesture', id: gestures[0]!.id, sx: 20.5 / 80, sy: 10.5 / 22, x: 20.5 / 80, y: 10.5 / 22, done: false })
  expect(gestures[gestures.length - 1]).toEqual({ op: 'gesture', id: gestures[0]!.id, sx: 20.5 / 80, sy: 10.5 / 22, x: 40.5 / 80, y: 5.5 / 22, done: true })
  await ui.unmount()
})

test('a double-click focuses the tile under it; keys zoom and fit', async ($, on) => {
  const { ui, clock, others } = await openCanvas($, on)
  await act(ui, 'pointer', { type: 'down', x: 60, y: 4, button: 'left', in: 'camera' })
  await act(ui, 'pointer', { type: 'up', x: 60, y: 4, button: 'left', in: 'camera' })
  await act(ui, 'pointer', { type: 'down', x: 60, y: 4, button: 'left', in: 'camera' })
  await act(ui, 'pointer', { type: 'up', x: 60, y: 4, button: 'left', in: 'camera' })
  await act(ui, 'key', { key: '+', in: 'camera' })
  await act(ui, 'key', { key: '0', in: 'camera' })
  await clock.settle()
  expect(others()).toEqual([
    { op: 'focus', x: 60.5 / 80, y: 4.5 / 22 },
    { op: 'zoom', factor: 1.25 },
    { op: 'fit' },
  ])
  await ui.unmount()
})

test('the wheel over the picture zooms around the pointer instead of scrolling the pane', async ($, on) => {
  const { ui, clock, moves } = await openCanvas($, on)
  const scrolled = await $.ui.scroll({
    component: 'Pane', requestId: 'replay-qa-canvas', offset: 0, by: -1, bodyRows: 24, contentRows: 24,
    origin: { kind: 'person' }, pointer: { column: 40, row: 12 },
  } as never)
  await clock.settle()
  expect(scrolled?.deny).toBeTruthy()
  expect(moves()).toEqual([{ op: 'zoom', factor: 1.15, x: 40.5 / 80, y: 11.5 / 22 }])
  await ui.unmount()
})

test('the footer zoom controls move the camera and show its zoom', async ($, on) => {
  const { ui, clock, moves } = await openCanvas($, on)
  for (const key of ['zoomIn', 'zoomOut', 'zoomPct', 'fit']) await ui.press({ key })
  await clock.settle()
  expect(moves()).toEqual([{ op: 'zoom', factor: 1.25 }, { op: 'zoom', factor: 0.8 }, { op: 'actual' }, { op: 'fit' }])
  expect((await ui.find({ key: 'zoomPct' }))?.text).toContain('150%')
  await ui.unmount()
})

test('pressing or dragging on the minimap moves the view there, and is no gesture', async ($, on) => {
  const { ui, clock, moves } = await openCanvas($, on)
  await ui.press({ key: 'fit' })
  await clock.settle()
  // The minimap spans columns 60-76 and rows 15.4-20.9 of the 80 x 22 picture.
  await act(ui, 'pointer', { type: 'down', x: 63, y: 16, button: 'left', in: 'camera' })
  await act(ui, 'pointer', { type: 'move', x: 71, y: 19, button: 'left', in: 'camera' })
  await act(ui, 'pointer', { type: 'up', x: 71, y: 19, button: 'left', in: 'camera' })
  await clock.settle()
  const jumps = moves().filter(m => m.op === 'minimap')
  expect(jumps.length).toBe(2)
  const near = (a: number, b: number) => Math.abs(a - b) < 1e-9
  expect(near(jumps[0]!.x as number, (63.5 / 80 - 0.75) / 0.2) && near(jumps[0]!.y as number, (16.5 / 22 - 0.7) / 0.25)).toBe(true)
  expect(near(jumps[1]!.x as number, (71.5 / 80 - 0.75) / 0.2) && near(jumps[1]!.y as number, (19.5 / 22 - 0.7) / 0.25)).toBe(true)
  expect(moves().some(m => m.op === 'gesture')).toBe(false)
  await ui.unmount()
})
