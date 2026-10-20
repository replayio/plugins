// node --test live/test/
import test from 'node:test'
import assert from 'node:assert/strict'

import { AuthError, NotFoundError, RecordingStream, apiBaseOf, isRenderable, tunnelServers } from '../qa-stream.mjs'
import { startMock } from './mock-qa-api.mjs'
import { synthEvents } from './synth.mjs'

const client = (mock, token = 'test-token') => async path => {
  const res = await fetch(`${mock.url}${path}`, { headers: token ? { authorization: `Bearer ${token}` } : {} })
  return { status: res.status, data: await res.json() }
}

const scenario = (events, extra = {}) => ({
  projects: [{ id: 'p1', name: 'Demo', journeys: [{ id: 'j1', name: 'Book a call' }], runs: [{ id: 'run-1', journey_id: 'j1', status: 'completed', title: 'Book a call', events, ...extra }] }],
})

async function readAll(stream) {
  const rows = []
  for (let more = true; more;) {
    const page = await stream.pull()
    rows.push(...page.rows)
    more = page.hasMore
  }
  return rows
}

test('reads a whole run page by page', async () => {
  const events = synthEvents({ steps: 30 })
  const mock = await startMock(scenario(events))
  try {
    const stream = new RecordingStream({ request: client(mock), projectId: 'p1', key: 'test_run_id', id: 'run-1', firstLimit: 7 })
    const rows = await readAll(stream)
    const rrweb = rows.filter(r => r.kind === 'rrweb').map(r => r.event)
    assert.equal(rrweb.length, events.length)
    assert.deepEqual(rrweb.map(e => e.timestamp), events.map(e => e.timestamp))
    assert.ok(rows.some(r => r.kind === 'note' && r.step), 'narration rows come through with their step')
    assert.ok(isRenderable(rrweb))
    assert.ok(mock.calls.filter(c => c.includes('recording-events')).length > 3, 'it paged')
  } finally {
    await mock.close()
  }
})

test('halves the page size on ResponseSizeTooLarge and keeps going', async () => {
  // The snapshot (~150 KB) is chunked into 60 KB rows, so a page of 20 rows is over the cap but
  // a few rows are not.
  const events = synthEvents({ steps: 6, bigBytes: 150_000 })
  const mock = await startMock(scenario(events), { maxPageBytes: 100_000, chunkBytes: 60_000 })
  try {
    const stream = new RecordingStream({ request: client(mock), projectId: 'p1', key: 'test_run_id', id: 'run-1', firstLimit: 20 })
    const rows = await readAll(stream)
    assert.equal(rows.filter(r => r.kind === 'rrweb').length, events.length)
    assert.ok(mock.calls.some(c => c.includes('limit=20')), 'it started at the full page size')
    assert.ok(mock.calls.some(c => /limit=(1|2|5|10)\b/.test(c)), 'and shrank after the 502')
    assert.ok(stream.limit < 20 || mock.calls.length > 3, 'and the stream still completed')
  } finally {
    await mock.close()
  }
})

test('joins rrweb-chunk rows, even when the pieces span pages', async () => {
  const events = synthEvents({ steps: 4, bigBytes: 1_500_000 })
  const mock = await startMock(scenario(events), { chunkBytes: 400_000, maxPageBytes: 5_000_000 })
  try {
    const stream = new RecordingStream({ request: client(mock), projectId: 'p1', key: 'test_run_id', id: 'run-1', firstLimit: 2 })
    const rows = await readAll(stream)
    const rrweb = rows.filter(r => r.kind === 'rrweb').map(r => r.event)
    assert.equal(rrweb.length, events.length)
    assert.deepEqual(rrweb[1], events[1], 'the oversize snapshot is whole again')
  } finally {
    await mock.close()
  }
})

test('follows a running recording by cursor and sees only new rows', async () => {
  const mock = await startMock(scenario(synthEvents({ steps: 40, stepMs: 100 }), { status: 'in-progress', live: { perSecond: 20 } }))
  try {
    const stream = new RecordingStream({ request: client(mock), projectId: 'p1', key: 'test_run_id', id: 'run-1', firstLimit: 50 })
    const first = await readAll(stream)
    assert.ok(first.length > 0 && first.length < 80, 'only part of the run exists yet')
    await new Promise(resolve => setTimeout(resolve, 700))
    const next = await readAll(stream)
    assert.ok(next.length > 0, 'later rows arrive')
    const seqs = [...first, ...next].map(r => r.seq)
    assert.deepEqual(seqs, [...new Set(seqs)], 'no row is read twice')
    mock.finish('run-1')
    const rest = await readAll(stream)
    assert.equal([...first, ...next, ...rest].filter(r => r.kind === 'rrweb').length, 42)
  } finally {
    await mock.close()
  }
})

test('names auth and missing-source failures', async () => {
  const mock = await startMock(scenario(synthEvents({ steps: 2 })))
  try {
    const unauth = new RecordingStream({ request: client(mock, null), projectId: 'p1', key: 'test_run_id', id: 'run-1' })
    await assert.rejects(unauth.pull(), AuthError)
    const missing = new RecordingStream({ request: client(mock), projectId: 'p1', key: 'test_run_id', id: 'nope' })
    await assert.rejects(missing.pull(), NotFoundError)
  } finally {
    await mock.close()
  }
})

test('names a QA server from an API base, a QA URL or a dashboard URL', () => {
  assert.equal(apiBaseOf('https://qa.replay.io/api/v1/'), 'https://qa.replay.io/api/v1')
  assert.equal(apiBaseOf('https://pr-6487--loop-qa-j63k5x.netlify.app'), 'https://pr-6487--loop-qa-j63k5x.netlify.app/api/v1')
  assert.equal(apiBaseOf('https://pr-6487--loop-qa-j63k5x.netlify.app/projects/proj-x/test-runs/ts-1'), 'https://pr-6487--loop-qa-j63k5x.netlify.app/api/v1')
  assert.equal(apiBaseOf('http://localhost:8080/api/v2/projects'), 'http://localhost:8080/api/v2')
  assert.equal(apiBaseOf('proj-x'), null)
  assert.equal(apiBaseOf(undefined), null)
})

test('reads the QA server of each running replayqa tunnel from ps', () => {
  const ps = [
    '/bin/zsh -c npx --yes replayqa proxy --project proj-a --qa-url https://pr-1--qa.netlify.app',
    'node /x/.bin/replayqa run http://localhost:3000 --project=proj-b --qa-url=https://staging.qa.example.com --no-app',
    'node /x/.bin/replayqa login',
    'node /x/.bin/replayqa proxy --project proj-c',
  ].join('\n')
  assert.deepEqual([...tunnelServers(ps)], [
    ['proj-a', 'https://pr-1--qa.netlify.app/api/v1'],
    ['proj-b', 'https://staging.qa.example.com/api/v1'],
  ])
})
