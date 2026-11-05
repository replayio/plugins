import test from 'node:test'
import assert from 'node:assert/strict'
import { dispatchDashboardInput } from '../dashboard-input.mjs'

test('pointer coordinates follow the resized viewport and stay inside its bounds', async () => {
  const calls = []
  const send = async (method, params) => calls.push({ method, ...params })
  await dispatchDashboardInput(send, { width: 1000, height: 600 }, { type: 'pointer', event: 'up', button: 'left', x: 2, y: -1 })
  assert.equal(calls[0].x, 999)
  assert.equal(calls[0].y, 0)
  assert.equal(calls[0].type, 'mouseReleased')
  assert.equal(calls[0].buttons, 0)
  await dispatchDashboardInput(send, { width: 500, height: 400 }, { type: 'wheel', x: 0.5, y: 0.5, deltaY: 40 })
  assert.equal(calls[1].x, 249.5)
  assert.equal(calls[1].deltaY, 40)
})

test('text and navigation keys reach the page, including former zoom shortcuts', async () => {
  const calls = []
  const send = async (method, params) => calls.push({ method, ...params })
  for (const key of ['+', '0', 'enter', 'tab']) await dispatchDashboardInput(send, {}, { type: 'key', key })
  assert.deepEqual(calls.slice(0, 2), [{ method: 'Input.insertText', text: '+' }, { method: 'Input.insertText', text: '0' }])
  assert.deepEqual(calls.slice(2).map(c => [c.type, c.key]), [['keyDown', 'Enter'], ['keyUp', 'Enter'], ['keyDown', 'Tab'], ['keyUp', 'Tab']])
})

test('coalesced input batches preserve quick clicks and do not replay previous events', async () => {
  const calls = []
  const send = async (method, params) => calls.push(params.type)
  const streams = new Map()
  const events = ['down', 'up'].map((event, i) => ({ seq: i + 1, input: { type: 'pointer', event, button: 'left', x: 0.5, y: 0.5 } }))
  const batch = { type: 'batch', stream: 'view-1', events }
  await dispatchDashboardInput(send, { width: 800, height: 600 }, batch, streams)
  await dispatchDashboardInput(send, { width: 800, height: 600 }, batch, streams)
  assert.deepEqual(calls, ['mousePressed', 'mouseReleased'])
})
