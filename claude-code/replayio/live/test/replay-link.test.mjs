// node --test live/test/replay-link.test.mjs
// A session's Replay recordings are the ones its pages reported, whatever else ran beside it.
// Runs the real relay against a stand-in `replayio` CLI that records what it is asked to upload.
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const RELAY = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'relay.mjs')
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const NOW = '2026-11-02T12:00:00.000Z'
const recording = (id, recordingStatus = 'finished') => ({
  id, date: NOW, duration: 1000, recordingStatus, metadata: { uri: 'http://localhost:3000/' },
})

/** A relay and a `replayio` that lists `list.json` and logs each `upload` to `uploads.log`. */
async function start(t, list) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'replay-link-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  fs.writeFileSync(path.join(dir, 'list.json'), JSON.stringify(list))
  const stub = path.join(dir, 'replayio')
  fs.writeFileSync(stub, `#!/bin/bash
case "$1" in
  list) cat "${dir}/list.json";;
  whoami) echo signed-in;;
  upload) shift; echo "$@" >> "${dir}/uploads.log";;
esac
`, { mode: 0o755 })
  const child = spawn(process.execPath, [RELAY], {
    env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, REPLAY_RRWEB_DIR: path.join(dir, 'data') },
    stdio: 'ignore',
  })
  t.after(() => child.kill())
  const file = path.join(dir, 'data', 'relay.json')
  let info = null
  for (let i = 0; i < 100 && !info; i++) {
    await sleep(50)
    try { info = JSON.parse(fs.readFileSync(file, 'utf8')) } catch {}
  }
  assert.ok(info, 'the relay started')
  const call = async (method, route, body) => {
    const res = await fetch(`http://127.0.0.1:${info.port}${route}${route.includes('?') ? '&' : '?'}token=${info.token}`, { method, body: body && JSON.stringify(body) })
    return { status: res.status, data: await res.json() }
  }
  /** Writes a finished session's .rrweb file, as the relay would have, and names it. */
  const session = (id, replayIds) => {
    const lines = [
      { type: 'header', id, session: id, source: 'agent-browser', cwd: '/repo', startedAt: Date.parse(NOW) },
      { type: 4, data: { href: 'http://localhost:3000/', width: 800, height: 600 }, timestamp: Date.parse(NOW) },
      { type: 2, data: {}, timestamp: Date.parse(NOW) + 1 },
      ...replayIds.map(replayId => ({ type: 'replay_id', id: replayId })),
      { type: 'end', endedAt: Date.parse(NOW) + 5000 },
    ]
    fs.writeFileSync(path.join(info.recordingsDir, `2026-11-02T12-00-00-${id}-${id}.rrweb`), lines.map(l => JSON.stringify(l)).join('\n') + '\n')
  }
  const uploads = () => {
    try { return fs.readFileSync(path.join(dir, 'uploads.log'), 'utf8').trim().split('\n') } catch { return [] }
  }
  return { call, session, uploads, listFile: path.join(dir, 'list.json') }
}

test('links only what the session reported, not another on the same host at the same moment', async t => {
  const relay = await start(t, [recording('mine'), recording('theirs')])
  relay.session('a', ['mine'])
  const linked = await relay.call('GET', '/recordings/a/replay')
  assert.deepEqual(linked.data.map(r => r.id), ['mine'])
})

test('uploads only that recording', async t => {
  const relay = await start(t, [recording('mine'), recording('theirs')])
  relay.session('a', ['mine'])
  const uploaded = await relay.call('POST', '/recordings/a/replay/upload', { login: false })
  assert.equal(uploaded.status, 200)
  assert.deepEqual(relay.uploads(), ['mine'])
})

test('a session with several documents links each of them', async t => {
  const relay = await start(t, [recording('one'), recording('two'), recording('theirs')])
  relay.session('a', ['one', 'two'])
  assert.deepEqual((await relay.call('GET', '/recordings/a/replay')).data.map(r => r.id), ['one', 'two'])
})

test('a session that reported nothing uploads nothing, and says so', async t => {
  const relay = await start(t, [recording('theirs')])
  relay.session('a', [])
  const uploaded = await relay.call('POST', '/recordings/a/replay/upload', { login: false })
  assert.equal(uploaded.status, 500)
  assert.match(uploaded.data.error, /no Replay recording was made/)
  assert.deepEqual(relay.uploads(), [])
})

test('waits for a recording that is still being written', async t => {
  const relay = await start(t, [recording('mine', 'recording')])
  relay.session('a', ['mine'])
  const pending = relay.call('POST', '/recordings/a/replay/upload', { login: false })
  await sleep(1500)
  assert.deepEqual(relay.uploads(), [], 'not uploaded while unfinished')
  fs.writeFileSync(relay.listFile, JSON.stringify([recording('mine')]))
  assert.equal((await pending).status, 200)
  assert.deepEqual(relay.uploads(), ['mine'])
})
