// node --test live/test/relay.test.mjs
// Starts the real relay against the mock QA API and drives it over HTTP. Recordings are read by the
// pinned replayqa CLI; REPLAY_QA_CLI ("node /path/to/replayqa-cli/bin.js") tests against a checkout.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

import { decodeCredential, exchangeCredential, mintWithToken, newPkcePair, refreshSession } from '../mcp-auth.mjs'
import { startMock } from './mock-qa-api.mjs'
import { synthEvents } from './synth.mjs'

const RELAY = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'relay.mjs')
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

async function startRelay(apiBase, dataDir, extraEnv = {}) {
  const child = spawn('node', [RELAY], {
    env: { ...process.env, REPLAY_QA_API_BASE: apiBase, REPLAY_QA_API_KEY: 'test', REPLAY_QA_LIVE_DIR: dataDir, ...extraEnv },
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
  const output = []
  child.stdout.on('data', d => output.push(String(d)))
  child.stderr.on('data', d => output.push(String(d)))
  const call = async (method, p, body, headers = {}) => {
    const res = await fetch(`http://127.0.0.1:${info.port}${p}${p.includes('?') ? '&' : '?'}token=${info.token}`, { method, body: body ? JSON.stringify(body) : undefined, headers })
    return { status: res.status, data: await res.json() }
  }
  /** What only the hooks module may do. */
  const hook = (method, p, body) => call(method, p, body, { 'x-replay-qa-hook-token': info.hookToken })
  return { info, call, hook, output: () => output.join(''), stop: signal => child.kill(signal) }
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
      id: 'proj-p1', name: 'Shop',
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
  const followed = await relay.call('POST', '/qa/follow', { projectId: 'proj-p1' })
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
  const watched = await relay.call('POST', '/qa/watch', { projectId: 'proj-p1', kind: 'test_run', sourceId: 'run-a', title: 'Checkout' })
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
  const again = await relay.call('POST', '/qa/watch', { projectId: 'proj-p1', kind: 'test_run', sourceId: 'run-a', title: 'Checkout' })
  assert.equal(again.data.recording.status, 'ended')
  assert.equal(again.data.recording.eventCount, done.length)
  assert.equal(mock.calls.filter(c => c.includes('recording-events')).length, before, 'no API request was needed')
})

test('reports a missing token and a missing project plainly', async t => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-relay-'))
  const mock = await startMock({ projects: [{ id: 'proj-p1', name: 'Shop', journeys: [], runs: [] }] })
  const relay = await startRelay(mock.url, dataDir)
  t.after(async () => { relay.stop(); await mock.close(); fs.rmSync(dataDir, { recursive: true, force: true }) })
  const res = await relay.call('GET', '/qa/overview?project=nope')
  assert.equal(res.status, 200)
  assert.match(res.data.error, /No Replay QA project nope/)
})


// -------------------------------------------------------------- the MCP sign-in

const FAKE_CLI = `node ${path.resolve(path.dirname(RELAY), 'test', 'fake-replayqa.mjs')}`

async function withRelay(t, scenario, extraEnv) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-relay-'))
  const mock = await startMock(scenario)
  const relay = await startRelay(mock.url, dataDir, extraEnv)
  t.after(async () => { relay.stop(); await mock.close(); fs.rmSync(dataDir, { recursive: true, force: true }) })
  return { mock, relay, dataDir }
}

const SHOP = { projects: [{ id: 'proj-shop', name: 'Shop', journeys: [], runs: [] }] }

/** What the hooks module does: asks the relay for a challenge, and hands back what the server minted for it. */
async function signIn(relay, mock) {
  const { data } = await relay.hook('POST', '/auth/challenge', {})
  return relay.hook('POST', '/auth/credential', { credential: mock.credential(data.code_challenge) })
}

test('the MCP sign-in is preferred over the existing token, refreshed in memory, and never logged', async t => {
  const { mock, relay } = await withRelay(t, SHOP)
  await relay.call('POST', '/qa/follow', { projectId: 'proj-shop' })
  assert.ok(mock.tokens.every(token => token === 'test'), 'with no sign-in, the existing token')

  // Only the hooks module may ask for a challenge or hand a credential over, and the answers hold no secret.
  assert.equal((await relay.call('POST', '/auth/challenge', {})).status, 403)
  const { data: { code_challenge: challenge } } = await relay.hook('POST', '/auth/challenge', {})
  assert.match(challenge, /^[A-Za-z0-9_-]{43}$/)
  const credential = mock.credential(challenge)
  assert.equal((await relay.call('POST', '/auth/credential', { credential })).status, 403)
  const adopted = await relay.hook('POST', '/auth/credential', { credential })
  assert.equal(adopted.status, 200)
  assert.equal(adopted.data.origin, mock.origin)
  assert.equal(JSON.stringify(adopted.data).includes('mcp_'), false)
  const status = await relay.call('GET', '/auth/status')
  assert.equal(status.data.mcp[0].origin, mock.origin)
  assert.equal(status.data.existing, true)
  assert.equal(JSON.stringify(status.data).includes('mcp_'), false)

  mock.tokens.length = 0
  assert.equal((await relay.call('GET', '/qa/overview?project=proj-shop&refresh=1')).data.error, null)
  assert.deepEqual([...new Set(mock.tokens)], ['mcp_access_1'])

  // A credential is single-use: the same one again is refused, with nothing of it echoed.
  const again = await relay.hook('POST', '/auth/credential', { credential })
  assert.equal(again.status, 400)
  assert.equal(again.data.error.includes(credential), false)

  // Nor can one minted for a challenge the relay did not make be redeemed, and nothing goes to the server.
  const redeemed = mock.oauth.requests.length
  await relay.hook('POST', '/auth/challenge', {})
  const stranger = await relay.hook('POST', '/auth/credential', { credential: mock.credential(newPkcePair().challenge) })
  assert.equal(stranger.status, 400)
  assert.match(stranger.data.error, /did not ask/)
  assert.equal(mock.oauth.requests.length, redeemed)

  // The server stops taking the token: one refresh, with the client id it asks for, and on it goes.
  mock.expireTokens()
  mock.tokens.length = 0
  assert.equal((await relay.call('GET', '/qa/overview?project=proj-shop&refresh=1')).data.error, null)
  assert.ok(mock.tokens.includes('mcp_access_2'))
  assert.deepEqual(mock.oauth.requests.find(r => r.grant_type === 'refresh_token'), { grant_type: 'refresh_token', refresh_token: 'mcr_refresh_1', client_id: 'client-1' })

  for (const secret of ['mcp_access', 'mcr_refresh', 'mcl_', 'verifier-1']) assert.equal(relay.output().includes(secret), false, secret)
})

test('a token nearing its end is refreshed before it is used, and a refused refresh falls back to the existing token', async t => {
  const { mock, relay } = await withRelay(t, SHOP)
  mock.oauth.expiresIn = 60 // inside the refresh margin at once
  await signIn(relay, mock)
  mock.tokens.length = 0
  await relay.call('GET', '/qa/overview?project=proj-shop&refresh=1')
  assert.ok(mock.oauth.generation >= 2, 'it refreshed')
  assert.ok(mock.tokens.every(token => token === `mcp_access_${mock.oauth.generation}` || token === 'mcp_access_2'), mock.tokens.join())

  mock.oauth.refresh.clear()
  mock.expireTokens()
  mock.tokens.length = 0
  assert.equal((await relay.call('GET', '/qa/overview?project=proj-shop&refresh=1')).data.error, null)
  assert.equal(mock.tokens.at(-1), 'test')
  assert.deepEqual((await relay.call('GET', '/auth/status')).data.mcp, [])
})

test('an MCP token only ever goes to the server that issued it', async t => {
  const other = await startMock({ projects: [{ id: 'proj-elsewhere', name: 'Elsewhere', journeys: [], runs: [] }] })
  t.after(() => other.close())
  const { mock, relay } = await withRelay(t, SHOP)
  await signIn(relay, mock)
  await relay.call('POST', '/qa/follow', { projectId: 'proj-elsewhere', server: other.url })
  assert.ok(other.tokens.length > 0)
  assert.ok(other.tokens.every(token => token === 'test'), other.tokens.join())
})

test('a reader whose token runs out starts again on a fresh one, with no row applied twice', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-reader-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const log = path.join(dir, 'readers.ndjson')
  const { mock, relay } = await withRelay(t, {
    projects: [{ id: 'proj-live', name: 'Live', journeys: [{ id: 'j1', name: 'Search' }], runs: [{ id: 'run-live', journey_id: 'j1', status: 'in-progress', title: 'Search', events: synthEvents({ title: 'Search', steps: 4 }), live: { perSecond: 1 } }] }],
  }, { REPLAY_QA_CLI: FAKE_CLI, FAKE_REPLAYQA_READER_LOG: log, REPLAY_QA_READER_MIN_LIFE_MS: '100' })
  await signIn(relay, mock)
  await relay.call('POST', '/qa/follow', { projectId: 'proj-live' })
  const recording = await until(async () => {
    const [rec] = (await relay.call('GET', '/recordings')).data
    return rec?.eventCount === 7 ? rec : null
  }, 15_000)
  assert.equal(recording.status, 'live')
  const keys = fs.readFileSync(log, 'utf8').trim().split('\n').map(line => JSON.parse(line).key)
  assert.equal(keys.length, 2)
  assert.equal(keys[0], 'mcp_access_1')
  assert.equal(keys[1], 'mcp_access_2', 'a fresh token, from a refresh')
  assert.equal(relay.output().includes('mcp_access'), false)
})

test('a reader refused at once is an error, not a loop', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-reader-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const log = path.join(dir, 'readers.ndjson')
  const { mock, relay } = await withRelay(t, {
    projects: [{ id: 'proj-live', name: 'Live', journeys: [{ id: 'j1', name: 'Search' }], runs: [{ id: 'run-live', journey_id: 'j1', status: 'in-progress', title: 'Search', events: synthEvents({ title: 'Search', steps: 4 }), live: { perSecond: 1 } }] }],
  }, { REPLAY_QA_CLI: FAKE_CLI, FAKE_REPLAYQA_READER_LOG: log })
  await signIn(relay, mock)
  await relay.call('POST', '/qa/follow', { projectId: 'proj-live' })
  const failed = await until(async () => {
    const [rec] = (await relay.call('GET', '/recordings')).data
    return rec?.status === 'error' ? rec : null
  }, 15_000)
  assert.match(failed.error, /answered 401/)
  assert.equal(fs.readFileSync(log, 'utf8').trim().split('\n').length, 1)
})

// ------------------------------------------------- with no MCP sign-in to be had

test('with no sign-in at all the canvas says what works: no /mcp, which would not help', async t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-home-'))
  t.after(() => fs.rmSync(home, { recursive: true, force: true }))
  const { relay } = await withRelay(t, SHOP, { HOME: home, REPLAY_QA_API_KEY: '' })
  const { error, authRequired } = (await relay.call('GET', '/qa/overview?project=proj-shop&refresh=1')).data
  assert.equal(authRequired, true)
  assert.equal(error, 'No Replay QA sign-in: run `npx --yes replayqa@0.7.0 login`, or set REPLAY_QA_API_KEY')
  assert.deepEqual((await relay.call('GET', '/auth/status')).data, { mcp: [], existing: false })
})

test('a sign-in the server refuses says the same, naming the server', async t => {
  const { mock, relay } = await withRelay(t, SHOP)
  mock.fail('proj-shop', 401)
  const { error } = (await relay.call('GET', '/qa/overview?project=proj-shop&refresh=1')).data
  assert.match(error, /Replay QA on 127\.0\.0\.1:\d+ answered 401 for project proj-shop: run `npx --yes replayqa@0\.7\.0 login`/)
  assert.equal(error.includes('/mcp'), false)
})

test('an existing replayqa login keeps working, with nothing from the MCP server', async t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-home-'))
  t.after(() => fs.rmSync(home, { recursive: true, force: true }))
  fs.mkdirSync(path.join(home, '.replay', 'profile'), { recursive: true })
  fs.writeFileSync(path.join(home, '.replay', 'profile', 'auth.json'), JSON.stringify({ accessToken: 'a.login.token', refreshToken: 'r' }))
  const { mock, relay } = await withRelay(t, SHOP, { HOME: home, REPLAY_QA_API_KEY: '' })
  const overview = (await relay.call('GET', '/qa/overview?project=proj-shop&refresh=1')).data
  assert.equal(overview.error, null)
  assert.equal(overview.project.name, 'Shop')
  assert.deepEqual([...new Set(mock.tokens)], ['a.login.token'])
  assert.deepEqual((await relay.call('GET', '/auth/status')).data, { mcp: [], existing: true })
})

test('a tunnel with no credential gets nothing of the plugin\'s, and runs on the CLI\'s own sign-in', async t => {
  const { runs, tunnel } = await runTunnel(t, { env: { REPLAY_QA_API_KEY: '' } })
  await until(async () => (await tunnel()).status === 'ready')
  const [run] = runs()
  assert.equal(run.key, '', 'nothing set: replayqa reads its own login')
  assert.equal(run.url, null)
  assert.equal(run.args.includes('--qa-url'), false)
})

// ---------------------------------------------------------------- server errors

test('an error names the server it asked, and says when that is a PR preview', async t => {
  const { mock, relay, dataDir } = await withRelay(t, SHOP)
  mock.fail('proj-shop', 500)
  const plain = (await relay.call('GET', '/qa/overview?project=proj-shop&refresh=1')).data
  assert.match(plain.error, new RegExp(`Replay QA on 127\\.0\\.0\\.1:\\d+ answered 500 for project proj-shop`))
  assert.equal(plain.error.includes('preview'), false)

  relay.stop()
  await sleep(200)
  // A project remembered on a PR's preview, as servers.json held in the report that started this.
  const preview = 'https://pr-7162--loop-qa-j63k5x.netlify.invalid/api/v1'
  fs.writeFileSync(path.join(dataDir, 'servers.json'), JSON.stringify({ 'proj-gone': preview }))
  const second = await startRelay(mock.url, dataDir)
  t.after(() => second.stop())
  const gone = (await second.call('GET', '/qa/overview?project=proj-gone')).data
  assert.match(gone.error, /pr-7162--loop-qa-j63k5x\.netlify\.invalid/)
  assert.match(gone.error, /preview of PR #7162/)
  assert.equal(gone.server, preview, 'the canvas chip names it even though it failed')
})

// ------------------------------------------------------------------ the folder

test('the folder view holds what the hooks module said, and presses wait for it on the feed', async t => {
  const { relay } = await withRelay(t, SHOP)
  assert.equal((await relay.call('POST', '/qa/folder', { folder: {} })).status, 403)
  const folder = { root: '/r', name: 'r', mode: 'configured', projects: [
    { project_id: 'proj-shop', path: 'apps/shop', qa_url: null },
    { project_id: 'proj-preview', path: 'apps/preview', qa_url: 'https://pr-1--qa.netlify.invalid' },
    { project_id: 'proj-missing', path: 'apps/missing', qa_url: null },
  ], workspace: { tools: [], package_manager: null }, apps: [], libraries: 0 }
  assert.equal((await relay.hook('POST', '/qa/folder', { folder })).status, 200)
  const named = await until(async () => {
    const r = await relay.call('GET', '/qa/folder')
    return r.data.summaries['proj-shop']?.name && r.data.summaries['proj-missing']?.error ? r.data : null
  })
  assert.equal(named.folder.name, 'r')
  assert.equal(named.summaries['proj-shop'].name, 'Shop')
  assert.match(named.summaries['proj-missing'].error, /answered 404/)
  assert.equal(named.summaries['proj-preview'], undefined, 'a server only the repo names is not asked until it is opened')

  const html = await fetch(`http://127.0.0.1:${relay.info.port}/folder?token=${relay.info.token}`)
  assert.match(await html.text(), /<title>Replay QA/)

  assert.equal((await relay.call('POST', '/qa/folder/action', { type: 'start', path: 'apps/web' })).data.queued, true)
  const feed = await relay.call('GET', '/frames?version=-1')
  assert.deepEqual(feed.data.actions, [{ type: 'start', path: 'apps/web' }])
  assert.deepEqual((await relay.call('GET', '/frames?version=-1')).data.actions, [], 'each press is handed over once')
})

test('a port check says whether something already listens', async t => {
  const { relay } = await withRelay(t, SHOP)
  assert.equal((await relay.call('GET', `/ports/${relay.info.port}`)).data.isOpen, true)
  const closed = await new Promise(resolve => {
    const probe = http.createServer().listen(0, '127.0.0.1', () => { const { port } = probe.address(); probe.close(() => resolve(port)) })
  })
  assert.equal((await relay.call('GET', `/ports/${closed}`)).data.isOpen, false)
})

// --------------------------------------------------------------------- tunnels

/** `signedIn`: the relay holds an MCP sign-in, so the run gets a credential minted on it. */
async function runTunnel(t, { env = {}, signedIn = false, noTool = false } = {}) {
  const log = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'qa-tunnel-')), 'runs.ndjson')
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-tunnel-cwd-'))
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }))
  const ctx = await withRelay(t, SHOP, { REPLAY_QA_CLI: FAKE_CLI, FAKE_REPLAYQA_LOG: log, ...env })
  const spec = {
    key: 'apps/web', label: '@x/web', cwd, targetUrl: 'http://localhost:4100',
    args: ['run', 'http://localhost:4100', '--app-command', 'pnpm dev', '--create-project', '--name', '@x/web'],
  }
  ctx.mock.oauth.noCredentialTool = noTool
  if (signedIn) await signIn(ctx.relay, ctx.mock)
  const started = await ctx.relay.hook('POST', '/tunnels', spec)
  assert.equal(started.status, 200)
  const runs = () => fs.readFileSync(log, 'utf8').trim().split('\n').map(line => JSON.parse(line))
  const tunnel = () => ctx.relay.call('GET', '/tunnels').then(r => r.data[0])
  return { ...ctx, spec, cwd, runs, tunnel }
}

test('a tunnel is only started by the hooks module, runs in its folder, reports its project and stops', async t => {
  const { relay, spec, cwd, runs, tunnel } = await runTunnel(t)
  assert.equal((await relay.call('POST', '/tunnels', spec)).status, 403)
  const ready = await until(async () => { const v = await tunnel(); return v.status === 'ready' ? v : null })
  assert.equal(ready.projectId, 'proj-created-by-cli')
  assert.equal(ready.text, 'Tunnel ready: Replay QA can reach the app.')
  const [run] = runs()
  assert.equal(run.cwd, fs.realpathSync(cwd))
  assert.ok(run.args.includes('--json'))
  assert.equal(run.key, 'test', 'with no sign-in it runs on the existing auth, as it would alone')

  // Started again it is the same run.
  await relay.hook('POST', '/tunnels', spec)
  assert.equal(runs().length, 1)
  assert.equal((await relay.call('GET', '/tunnels')).data.length, 1)

  assert.equal((await relay.call('POST', '/tunnels/apps%2Fweb/stop', {})).status, 403)
  await relay.hook('POST', '/tunnels/apps%2Fweb/stop', {})
  const stopped = await until(async () => { const v = await tunnel(); return v.isRunning ? null : v })
  assert.equal(stopped.status, 'stopped')
  assert.equal(stopped.error, null)
})

test('with an MCP sign-in, each run gets a credential of its own, in its environment, for the server that issued it', async t => {
  const { mock, relay, runs, tunnel } = await runTunnel(t, { signedIn: true })
  const ready = await until(async () => { const v = await tunnel(); return v.status === 'ready' ? v : null })
  assert.equal(ready.qaUrl, mock.origin)
  const [run] = runs()
  assert.match(run.key, /^mcl_/)
  assert.equal(run.url, mock.origin)
  assert.equal(run.base, null, 'a server the environment named does not get it')
  assert.equal(run.args[run.args.indexOf('--qa-url') + 1], mock.origin)
  assert.deepEqual(mock.oauth.mcpCalls, ['create_cli_credential'], 'minted with the relay\'s own token')
  assert.equal(mock.oauth.requests.length, 1, 'the relay\'s own exchange: the CLI exchanges the one it got')
  assert.equal(run.args.some(arg => /mcl_|mcp_/.test(arg)), false, 'never in its arguments')
  assert.equal(relay.output().includes('mcl_'), false)
})

test('a project the tunnel made is read from the server that issued the credential', async t => {
  const { relay, mock, tunnel } = await runTunnel(t, { signedIn: true, env: { FAKE_REPLAYQA_PROJECT: 'proj-shop' } })
  await until(async () => (await tunnel()).projectId === 'proj-shop')
  const overview = (await relay.call('GET', '/qa/overview?project=proj-shop&refresh=1')).data
  assert.equal(overview.error, null)
  assert.equal(overview.project.name, 'Shop')
  assert.ok(mock.calls.some(call => call.includes('/projects/proj-shop')))
})

test('a tunnel that fails says why, and a token in its output is scrubbed', async t => {
  const { relay, tunnel } = await runTunnel(t, { env: { FAKE_REPLAYQA_FAIL: 'Timed out waiting for http://localhost:4100.', FAKE_REPLAYQA_LEAK: '1' }, signedIn: true })
  const failed = await until(async () => { const v = await tunnel(); return v.isRunning ? null : v })
  assert.equal(failed.status, 'failed')
  assert.equal(failed.error, 'Timed out waiting for http://localhost:4100.')
  assert.equal(JSON.stringify(failed).includes('dist/bin.js'), false, 'no stack frames')
  const shown = JSON.stringify(failed)
  assert.match(shown, /mcl_\*\*\*/)
  assert.equal(/mcl_[A-Za-z0-9]/.test(shown) || /mcl_[A-Za-z0-9]/.test(relay.output()), false)
})

test('a signed-in relay whose server cannot mint leaves the run on the CLI\'s own sign-in', async t => {
  const { runs, tunnel } = await runTunnel(t, { signedIn: true, noTool: true })
  await until(async () => (await tunnel()).status === 'ready')
  const [run] = runs()
  assert.equal(run.key, 'test')
  assert.equal(run.args.includes('--qa-url'), false)
})

test('a credential for a process the hooks module runs: its own each time, only for the hooks module, none with no sign-in', async t => {
  const { mock, relay } = await withRelay(t, SHOP)
  assert.deepEqual((await relay.hook('POST', '/auth/mint', {})).data, { credential: null, qaUrl: null })
  assert.equal((await relay.call('POST', '/auth/mint', {})).status, 403)
  await signIn(relay, mock)
  const first = (await relay.hook('POST', '/auth/mint', {})).data
  const second = (await relay.hook('POST', '/auth/mint', {})).data
  assert.match(first.credential, /^mcl_/)
  assert.equal(first.qaUrl, mock.origin)
  assert.notEqual(first.credential, second.credential)
  assert.equal(relay.output().includes('mcl_'), false)
  // A token the server has stopped taking gets a refresh and one more try.
  mock.expireTokens()
  assert.match((await relay.hook('POST', '/auth/mint', {})).data.credential, /^mcl_/)
  assert.ok(mock.oauth.generation >= 2)
})

const isAlive = pid => { try { process.kill(pid, 0); return true } catch { return false } }

test('stopping a tunnel before it is up also stops the app replayqa left in a group of its own', async t => {
  const pidFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'qa-tunnel-')), 'app.pid')
  const { relay, tunnel } = await runTunnel(t, { env: { FAKE_REPLAYQA_APP_PID_FILE: pidFile } })
  const pid = await until(async () => (fs.existsSync(pidFile) ? Number(fs.readFileSync(pidFile, 'utf8')) : null))
  t.after(() => { try { process.kill(pid, 'SIGKILL') } catch {} })
  await until(async () => (await tunnel()).status === 'starting-app')
  assert.equal(isAlive(pid), true)
  await relay.hook('POST', '/tunnels/apps%2Fweb/stop', {})
  const stopped = await until(async () => { const v = await tunnel(); return v.isRunning ? null : v }, 15_000)
  assert.equal(stopped.status, 'stopped')
  await until(() => !isAlive(pid), 5_000)
})

test('the session ending takes a tunnel with it even before it is up', async t => {
  const pidFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'qa-tunnel-')), 'app.pid')
  const { relay, tunnel } = await runTunnel(t, { env: { FAKE_REPLAYQA_APP_PID_FILE: pidFile } })
  const pid = await until(async () => (fs.existsSync(pidFile) ? Number(fs.readFileSync(pidFile, 'utf8')) : null))
  t.after(() => { try { process.kill(pid, 'SIGKILL') } catch {} })
  await until(async () => (await tunnel()).status === 'starting-app')
  relay.stop()
  await until(() => !isAlive(pid), 5_000)
})

test('the session ending takes its tunnels with it', async t => {
  const { relay, tunnel, runs } = await runTunnel(t, { env: { FAKE_REPLAYQA_PROJECT: 'proj-x' } })
  await until(async () => (await tunnel()).status === 'ready')
  const [{ pid }] = runs()
  assert.equal(isAlive(pid), true)
  relay.stop()
  await until(() => !isAlive(pid), 5_000)
})

test('a closed terminal takes its tunnels with it', async t => {
  const { relay, tunnel, runs } = await runTunnel(t, { env: { FAKE_REPLAYQA_PROJECT: 'proj-x' } })
  await until(async () => (await tunnel()).status === 'ready')
  const [{ pid }] = runs()
  relay.stop('SIGHUP')
  await until(() => !isAlive(pid), 5_000)
})

// ------------------------------------------------------------- the credential

const credentialFor = origin => `mcl_${Buffer.from(JSON.stringify({ u: origin, i: 'client-1', c: 'code-1', v: 'verifier-1', r: 'http://cli/callback' })).toString('base64url')}`

test('a credential is exchanged and refreshed with the form the QA server takes', async t => {
  const mock = await startMock(SHOP)
  t.after(() => mock.close())
  const { verifier, challenge } = newPkcePair()
  const session = await exchangeCredential(mock.credential(challenge, 'code-a'), verifier)
  assert.equal(session.origin, mock.origin)
  assert.equal(session.accessToken, 'mcp_access_1')
  const [first] = mock.oauth.requests
  assert.deepEqual(first, { grant_type: 'authorization_code', code: 'code-a', redirect_uri: 'http://127.0.0.1/callback', client_id: 'client-1', code_verifier: verifier })
  const fresh = await refreshSession(session)
  assert.equal(fresh.accessToken, 'mcp_access_2')
  assert.equal(fresh.refreshToken, 'mcr_refresh_2')
  assert.deepEqual(mock.oauth.requests[1], { grant_type: 'refresh_token', refresh_token: 'mcr_refresh_1', client_id: 'client-1' })
})

test('minting on a token: what the server gives, or nothing, or a refusal to act on', async t => {
  const mock = await startMock(SHOP)
  t.after(() => mock.close())
  const pair = newPkcePair()
  const { accessToken } = await exchangeCredential(mock.credential(pair.challenge), pair.verifier)
  // It carries the verifier the server never saw, so a child process can redeem it.
  const minted = await mintWithToken(mock.origin, accessToken)
  assert.match(minted, /^mcl_/)
  assert.equal((await exchangeCredential(minted)).origin, mock.origin)
  mock.oauth.noCredentialTool = true
  assert.equal(await mintWithToken(mock.origin, accessToken), null)
  await assert.rejects(mintWithToken(mock.origin, 'mcp_not_a_token'), err => err.status === 401 && !err.message.includes('mcp_not_a_token'))
})

test('a bad credential is refused without echoing it', async t => {
  const mock = await startMock(SHOP)
  t.after(() => mock.close())
  assert.throws(() => decodeCredential('lqa_secret'), err => !err.message.includes('secret'))
  assert.throws(() => decodeCredential('mcl_!!!secret'), err => !err.message.includes('secret'))
  assert.throws(() => decodeCredential(credentialFor('http://evil.example')), /insecure/)
  await assert.rejects(exchangeCredential(credentialFor(mock.origin)), err => {
    assert.match(err.message, /invalid_grant/)
    assert.equal(err.message.includes('code-1'), false)
    assert.equal(err.message.includes('verifier-1'), false)
    return true
  })
})

test('dashboard browser loads /p/, forwards clicks and typing, and resizes without losing page state', async t => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-dashboard-'))
  const observations = []
  const site = http.createServer((req, res) => {
    if (req.url.startsWith('/api/observed')) {
      observations.push({ url: req.url, auth: req.headers.authorization })
      res.end('{}')
      return
    }
    res.setHeader('content-type', 'text/html')
    res.end(`<style>html,body{margin:0}button{position:fixed;left:0;top:0;width:50vw;height:50vh}input{position:fixed;left:50vw;top:0;width:49vw;height:50vh}</style>
      <div style="height:2000px"></div><button onclick="this.textContent=++window.clicks;report()">Click</button><input oninput="report()">
      <script>window.clicks=0;function report(){fetch('/api/observed?'+new URLSearchParams({clicks:window.clicks,width:innerWidth,height:innerHeight,scroll:scrollY,text:document.querySelector('input').value}))}onresize=report;onscroll=report;report()</script>`)
  })
  await new Promise(resolve => site.listen(0, '127.0.0.1', resolve))
  const origin = `http://127.0.0.1:${site.address().port}`
  const relay = await startRelay(`${origin}/api/v1`, dataDir)
  t.after(async () => { relay.stop(); await new Promise(resolve => site.close(resolve)); fs.rmSync(dataDir, { recursive: true, force: true }) })
  const redirect = await fetch(`http://127.0.0.1:${relay.info.port}/canvas/proj-dashboard?token=${relay.info.token}`, { redirect: 'manual' })
  assert.equal(redirect.headers.get('location'), `${origin}/p/proj-dashboard/overview`)
  const view = await relay.call('POST', '/canvas/proj-dashboard/view', { width: 800, height: 600 })
  assert.equal(view.status, 200, JSON.stringify(view.data))
  await until(() => observations.length)
  assert.equal(observations.at(-1).auth, 'Bearer test')
  const input = body => relay.call('POST', '/canvas/proj-dashboard/input', body)
  const click = { type: 'batch', stream: 'test', events: ['down', 'up'].map((event, i) => ({ seq: i + 1, input: { type: 'pointer', event, button: 'left', x: 0.25, y: 0.25 } })) }
  await input(click)
  await input(click) // Redelivered client history must not click twice.
  await until(() => observations.some(o => new URL(o.url, origin).searchParams.get('clicks') === '1'))
  await input({ type: 'pointer', event: 'down', button: 'left', x: 0.75, y: 0.25 })
  await input({ type: 'pointer', event: 'up', button: 'left', x: 0.75, y: 0.25 })
  await input({ type: 'key', key: 'x' })
  await until(() => observations.some(o => new URL(o.url, origin).searchParams.get('text') === 'x'))
  await input({ type: 'wheel', x: 0.75, y: 0.75, deltaY: 300 })
  await until(() => observations.some(o => Number(new URL(o.url, origin).searchParams.get('scroll')) > 0))
  assert.equal((await relay.call('POST', '/canvas/proj-dashboard/view', { width: 1000, height: 700 })).status, 200)
  await until(() => observations.some(o => new URL(o.url, origin).searchParams.get('width') === '1000'))
  const last = new URL(observations.at(-1).url, origin).searchParams
  assert.equal(last.get('height'), '700')
  assert.equal(last.get('clicks'), '1')
  assert.equal(last.get('text'), 'x')
  for (const event of ['down', 'up']) await input({ type: 'pointer', event, button: 'left', x: 0.25, y: 0.25 })
  await until(() => observations.some(o => new URL(o.url, origin).searchParams.get('clicks') === '2'))
  await relay.call('POST', '/canvas/proj-dashboard/view', { on: false })
})


test('project access denial is not a request to sign in again', async t => {
  const { mock, relay } = await withRelay(t, SHOP)
  mock.fail('proj-shop', 403)
  const denied = (await relay.call('GET', '/qa/overview?project=proj-shop&refresh=1')).data
  assert.equal(denied.authRequired, false)
  assert.match(denied.error, /denied access.*project member/)
  assert.equal(denied.error.includes('login'), false)
})

test('a browser login saved while the relay is running recovers the project without a restart', async t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-home-'))
  t.after(() => fs.rmSync(home, { recursive: true, force: true }))
  const { relay } = await withRelay(t, SHOP, { HOME: home, REPLAY_QA_API_KEY: '' })
  const read = () => relay.call('GET', '/qa/overview?project=proj-shop&refresh=1')
  assert.equal((await read()).data.authRequired, true)
  fs.mkdirSync(path.join(home, '.replay', 'profile'), { recursive: true })
  fs.writeFileSync(path.join(home, '.replay', 'profile', 'auth.json'), JSON.stringify({ accessToken: 'browser.login.token', refreshToken: 'r' }))
  const ready = (await read()).data
  assert.equal(ready.authRequired, false)
  assert.equal(ready.error, null)
  assert.equal(ready.project.id, 'proj-shop')
})
