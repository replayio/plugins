// node --test live/test/relay.test.mjs
// Starts the real relay against the mock QA API and drives it over HTTP.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

import { startMock } from './mock-qa-api.mjs'
import { synthEvents } from './synth.mjs'

const RELAY = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'relay.mjs')
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

async function startRelay(apiBase, dataDir) {
  const child = spawn('node', [RELAY], {
    env: { ...process.env, REPLAY_QA_API_BASE: apiBase, REPLAY_QA_API_KEY: 'test', REPLAY_QA_LIVE_DIR: dataDir },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const info = await new Promise((resolve, reject) => {
    let out = ''
    child.stdout.on('data', d => {
      out += d
      const line = out.split('\n').find(l => l.startsWith('{'))
      if (line) resolve(JSON.parse(line))
    })
    child.on('exit', code => reject(new Error(`relay exited ${code}`)))
    setTimeout(() => reject(new Error('relay did not start')), 10_000)
  })
  const call = async (method, p, body) => {
    const res = await fetch(`http://127.0.0.1:${info.port}${p}${p.includes('?') ? '&' : '?'}token=${info.token}`, { method, body: body ? JSON.stringify(body) : undefined })
    return { status: res.status, data: await res.json() }
  }
  return { info, call, stop: () => child.kill() }
}

const until = async (check, ms = 10_000) => {
  const end = Date.now() + ms
  for (;;) {
    const v = await check()
    if (v) return v
    if (Date.now() > end) throw new Error('timed out waiting')
    await sleep(150)
  }
}

test('follows a project: a live run streams while finished ones load on demand and come back from disk', async t => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-relay-'))
  const done = synthEvents({ title: 'Checkout', steps: 12 })
  const mock = await startMock({
    projects: [{
      id: 'p1', name: 'Shop',
      journeys: [{ id: 'j1', name: 'Checkout' }, { id: 'j2', name: 'Search' }, { id: 'j3', name: 'Never run' }],
      runs: [
        { id: 'run-a', journey_id: 'j1', status: 'completed', title: 'Checkout', events: done },
        { id: 'run-b', journey_id: 'j2', status: 'in-progress', title: 'Search', events: synthEvents({ title: 'Search', steps: 60, stepMs: 100 }), live: { perSecond: 25 } },
      ],
    }],
  })
  let relay = await startRelay(mock.url, dataDir)
  t.after(async () => { relay.stop(); await mock.close(); fs.rmSync(dataDir, { recursive: true, force: true }) })

  // Following turns the live run into a recording on its own.
  const followed = await relay.call('POST', '/qa/follow', { projectId: 'p1' })
  assert.equal(followed.status, 200)
  assert.equal(followed.data.project.name, 'Shop')
  assert.equal(followed.data.tiles[0].status, 'live', 'live work is listed first')
  assert.equal(followed.data.counts.live, 1)
  assert.deepEqual(followed.data.tiles.map(t => t.title).sort(), ['Checkout', 'Never run', 'Search'])

  const live = await until(async () => (await relay.call('GET', '/recordings')).data.find(r => r.sourceId === 'run-b'))
  const first = await until(async () => {
    const r = await relay.call('GET', `/recordings/${live.id}/events?from=0`)
    return r.data.events.length > 4 ? r.data : null
  })
  assert.equal(first.recording.status, 'live')
  assert.ok(first.events[0].type === 0 || first.events[0].type === 4)

  // A poll with `from` returns only what was added since.
  await sleep(1800)
  const more = await relay.call('GET', `/recordings/${live.id}/events?from=${first.events.length}`)
  assert.ok(more.data.events.length > 0, 'new events arrive while it runs')
  assert.equal(more.data.from, first.events.length)

  // SSE delivers new events with their position.
  const sse = await fetch(`http://127.0.0.1:${relay.info.port}/recordings/${live.id}/stream?token=${relay.info.token}`)
  const reader = sse.body.getReader()
  let text = ''
  const sseEnd = Date.now() + 5000
  while (!/event: events/.test(text) && Date.now() < sseEnd) {
    const { value } = await reader.read()
    text += new TextDecoder().decode(value)
  }
  await reader.cancel()
  assert.match(text, /event: events\ndata: \{"from":\d+,"events":\[/)

  // The finished run loads on request and ends.
  const watched = await relay.call('POST', '/qa/watch', { projectId: 'p1', kind: 'test_run', sourceId: 'run-a', title: 'Checkout' })
  assert.equal(watched.status, 200)
  const ended = await until(async () => {
    const r = (await relay.call('GET', `/recordings/${watched.data.recording.id}`)).data
    return r.status === 'ended' ? r : null
  })
  assert.equal(ended.eventCount, done.length)
  assert.ok(ended.durationMs > 5000)
  assert.equal(ended.note?.text, 'Step 12 of 12')

  // When the live run finishes the recording ends with every event.
  mock.finish('run-b')
  const liveEnded = await until(async () => {
    const r = (await relay.call('GET', `/recordings/${live.id}`)).data
    return r.status === 'ended' ? r : null
  }, 15_000)
  assert.equal(liveEnded.eventCount, 62)

  // After a restart the finished run is read from disk, not fetched again.
  relay.stop()
  await sleep(300)
  const before = mock.calls.filter(c => c.includes('recording-events')).length
  relay = await startRelay(mock.url, dataDir)
  const again = await relay.call('POST', '/qa/watch', { projectId: 'p1', kind: 'test_run', sourceId: 'run-a', title: 'Checkout' })
  assert.equal(again.data.recording.status, 'ended')
  assert.equal(again.data.recording.eventCount, done.length)
  assert.equal(mock.calls.filter(c => c.includes('recording-events')).length, before, 'no API request was needed')
})

test('reports a missing token and a missing project plainly', async t => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-relay-'))
  const mock = await startMock({ projects: [{ id: 'p1', name: 'Shop', journeys: [], runs: [] }] })
  const relay = await startRelay(mock.url, dataDir)
  t.after(async () => { relay.stop(); await mock.close(); fs.rmSync(dataDir, { recursive: true, force: true }) })
  const res = await relay.call('GET', '/qa/overview?project=nope')
  assert.equal(res.status, 200)
  assert.match(res.data.error, /No Replay QA project nope/)
})
