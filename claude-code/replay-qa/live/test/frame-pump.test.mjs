import test from 'node:test'
import assert from 'node:assert/strict'
import { createFramePump } from '../frame-pump.mjs'

const turn = () => new Promise(resolve => setImmediate(resolve))

test('slow frame writes never overlap and stale pending frames are replaced by the newest', async () => {
  const gate = Promise.withResolvers()
  const frames = []
  let active = 0
  let maxActive = 0
  const pump = createFramePump({ fps: 1e9, write: async frame => {
    maxActive = Math.max(maxActive, ++active)
    if (frame === 'first') await gate.promise
    frames.push(frame)
    active--
  } })
  pump.push('first')
  await turn()
  pump.push('obsolete')
  pump.push('latest')
  gate.resolve()
  await turn()
  await pump.close()
  assert.equal(maxActive, 1)
  assert.deepEqual(frames, ['first', 'latest'])
})

test('closing a view prevents an in-flight frame from being published after it is replaced', async () => {
  const gate = Promise.withResolvers()
  const published = []
  const pump = createFramePump({ fps: 30, write: async (frame, isCurrent) => { await gate.promise; if (isCurrent()) published.push(frame) } })
  pump.push('old view')
  await turn()
  const closed = pump.close()
  pump.push('another old frame')
  gate.resolve()
  await closed
  assert.deepEqual(published, [])
})
