#!/usr/bin/env node
// Stands in for the pinned replayqa (REPLAY_QA_CLI): plays `replayqa run --json` as it really reads
// (src/commands/run.ts, src/commands/proxy.ts), so tests and the demo start no real tunnel. Any other
// verb goes to FAKE_REPLAYQA_REAL, the CLI that really reads recordings.
// FAKE_REPLAYQA_LOG: a file each run writes its view to. FAKE_REPLAYQA_FAIL: exit with that error before
// the tunnel is up. FAKE_REPLAYQA_PROJECT: the project it makes. FAKE_REPLAYQA_STEP_MS: its pace.
// FAKE_REPLAYQA_READER_LOG: play `recording-events` too. Its first run reads five rows and is refused, as a
// token running out is (exit 2), and later runs read from the top again and stay up.
// FAKE_REPLAYQA_APP_PID_FILE: start an "app" the way the real one does, in a process group of its own and
// holding this process's stdio, then wait for a tunnel with no signal handler, as replayqa does at that point.
import fs from 'node:fs'
import path from 'node:path'
import { spawn, spawnSync } from 'node:child_process'

const args = process.argv.slice(2)
if (args[0] === 'recording-events' && process.env.FAKE_REPLAYQA_READER_LOG) {
  const log = process.env.FAKE_REPLAYQA_READER_LOG
  const starts = fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').length : 0
  fs.appendFileSync(log, `${JSON.stringify({ key: process.env.REPLAY_QA_API_KEY ?? null })}\n`)
  const rows = count => { for (let seq = 0; seq < count; seq++) console.log(JSON.stringify({ kind: 'rrweb', event: { type: 3, data: {}, timestamp: 1000 + seq }, task_id: 'task-1', seq })) }
  if (starts === 0) {
    rows(5)
    await new Promise(resolve => setTimeout(resolve, 150))
    console.error('Replay QA answered 401')
    process.exit(2)
  }
  rows(7)
  setInterval(() => {}, 1000)
  await new Promise(() => {})
}
if (args[0] !== 'run') {
  const [real, ...realArgs] = (process.env.FAKE_REPLAYQA_REAL ?? 'npx --yes replayqa@0.7.0').split(' ')
  process.exit(spawnSync(real, [...realArgs, ...args], { stdio: 'inherit' }).status ?? 1)
}
const option = name => { const i = args.indexOf(name); return i === -1 ? undefined : args[i + 1] }
const pause = ms => new Promise(resolve => setTimeout(resolve, ms))
const emit = (event, data = {}) => console.log(JSON.stringify({ event, ...data }))

if (process.env.FAKE_REPLAYQA_LOG) {
  fs.appendFileSync(process.env.FAKE_REPLAYQA_LOG, `${JSON.stringify({
    pid: process.pid, cwd: process.cwd(), args, key: process.env.REPLAY_QA_API_KEY ?? null, url: process.env.REPLAY_QA_URL ?? null,
    base: process.env.REPLAY_QA_API_BASE ?? null,
  })}\n`)
}
if (process.env.FAKE_REPLAYQA_APP_PID_FILE) {
  const app = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'inherit', detached: true })
  fs.writeFileSync(process.env.FAKE_REPLAYQA_APP_PID_FILE, String(app.pid))
  console.log(`Starting local app: ${option('--app-command') ?? 'npm run dev'}`)
  setInterval(() => {}, 1000)
  await new Promise(() => {})
}
const project = process.env.FAKE_REPLAYQA_PROJECT ?? 'proj-created-by-cli'
const step = Number(process.env.FAKE_REPLAYQA_STEP_MS ?? 30)
process.once('SIGTERM', () => { emit('stopped', { project }); process.exit(0) })
console.log(`Starting local app: ${option('--app-command') ?? 'npm run dev'}`)
await pause(step)
console.log('  VITE ready in 120 ms')
if (process.env.FAKE_REPLAYQA_LEAK) console.log(`app printed REPLAY_QA_API_KEY=${process.env.REPLAY_QA_API_KEY}`)
if (process.env.FAKE_REPLAYQA_FAIL) {
  // As replayqa's bin does: the stack, whole.
  console.error(`Error: ${process.env.FAKE_REPLAYQA_FAIL}\n    at waitUntil (/x/dist/commands/run.js:1:1)\n    at async main (/x/dist/bin.js:37:5)`)
  process.exit(1)
}
console.log(`Local app is reachable at ${args[1]}`)
await pause(step)
if (args.includes('--create-project')) {
  fs.mkdirSync('.replay', { recursive: true })
  fs.writeFileSync(path.join('.replay', 'config.json'), `${JSON.stringify({ 'qa-project-id': project }, null, 2)}\n`)
}
console.log(`Created Replay QA project ${project}`)
emit('starting', { project, targetUrl: args[1], allowlist: ['localhost'] })
await pause(step)
emit('tunnel-status', { state: 'pending', frpcConnected: false, ready: false })
await pause(step)
emit('heartbeat', { ready: false, frpcConnected: true, targetReachable: false, reverseProxyStatus: 'pending' })
await pause(step)
emit('heartbeat', { ready: true, frpcConnected: true, targetReachable: true, reverseProxyStatus: 'ready' })
setInterval(() => {}, 1000)
