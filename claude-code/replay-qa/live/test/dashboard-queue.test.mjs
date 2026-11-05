import test from 'node:test'
import assert from 'node:assert/strict'
import { createDashboardQueue } from '../dashboard-queue.mjs'

const batch = (seq, input) => ({ type: 'batch', stream: 'pointer', events: [{ seq, input }] })
const move = x => ({ type: 'pointer', event: 'move', x, y: 0.5 })
const click = event => ({ type: 'pointer', event, button: 'left', x: 0.5, y: 0.5 })

test('a click does not wait behind obsolete hover positions; button and key order is preserved', async () => {
  const gate = Promise.withResolvers()
  const sent = []
  const queue = createDashboardQueue({ sendInput: async input => { sent.push(input); if (sent.length === 1) await gate.promise } })
  queue.push(batch(1, move(0)))
  for (let seq = 2; seq <= 101; seq++) queue.push(batch(seq, move(seq / 101)))
  queue.push(batch(102, click('down')))
  queue.push(batch(103, click('up')))
  queue.push(batch(104, { type: 'key', key: 'x' }))
  gate.resolve()
  await queue.idle()
  assert.equal(sent.length, 2)
  assert.deepEqual(sent[1].events.map(e => [e.seq, e.input.event ?? e.input.key]), [[101, 'move'], [102, 'down'], [103, 'up'], [104, 'x']])
})

test('cumulative client history is sent once, including a quick click', async () => {
  const sent = []
  const queue = createDashboardQueue({ sendInput: async input => sent.push(input) })
  const history = { type: 'batch', stream: 'pointer', events: [1, 2].map((seq, i) => ({ seq, input: click(i ? 'up' : 'down') })) }
  queue.push(history)
  queue.push(history)
  await queue.idle()
  assert.deepEqual(sent.flatMap(b => b.events.map(e => e.seq)), [1, 2])
})

test('pending resize storms collapse to the latest size without reordering clicks', async () => {
  const gate = Promise.withResolvers()
  const sent = []
  const queue = createDashboardQueue({
    sendInput: async input => sent.push(input),
    resize: async size => { sent.push(size); if (sent.length === 1) await gate.promise },
  })
  queue.resize({ width: 800, height: 600 })
  for (let width = 801; width <= 900; width++) queue.resize({ width, height: 600 })
  queue.push(batch(1, click('down')))
  queue.push(batch(2, click('up')))
  gate.resolve()
  await queue.idle()
  assert.equal(sent.length, 3)
  assert.equal(sent[1].width, 900)
  assert.deepEqual(sent[2].events.map(e => e.input.event), ['down', 'up'])
})

test('only sequenced batches retry, and a closed project discards pending actions', async () => {
  const gate = Promise.withResolvers()
  const sent = []
  const queue = createDashboardQueue({ sendInput: async input => { sent.push(input); if (sent.length === 1) { await gate.promise; throw new Error('lost response') } } })
  queue.push(batch(1, click('down')))
  gate.resolve()
  await queue.idle()
  assert.equal(sent.length, 2)
  assert.deepEqual(sent[0], sent[1])
  queue.close()
  queue.push(batch(2, click('up')))
  await queue.idle()
  assert.equal(sent.length, 2)
})
