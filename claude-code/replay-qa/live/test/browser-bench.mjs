// Local-only browser bridge benchmark. No real QA runs or credentials.
import { createDashboardQueue } from '../dashboard-queue.mjs'
import http from 'node:http'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const relayPath = process.argv[2] ?? fileURLToPath(new URL('../relay.mjs', import.meta.url))
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'qa-browser-bench-'))
let clickedAt = 0
const site = http.createServer((req, res) => {
  if (req.url === '/api/click') { clickedAt = performance.now(); res.end('{}'); return }
  res.setHeader('content-type', 'text/html')
  res.end(`<style>body{margin:0;background:#fff}button{position:absolute;left:0;top:0;width:50vw;height:50vh}i{display:block;position:absolute;top:60vh;width:60px;height:60px;background:#f02d5e;animation:move 1s linear infinite alternate}@keyframes move{to{transform:translateX(600px)}}</style><button onclick="fetch('/api/click')">Click</button><i></i>`)
})
await new Promise(resolve => site.listen(0, '127.0.0.1', resolve))
const child = spawn('node', [relayPath], { env: { ...process.env, REPLAY_QA_API_KEY: 'benchmark', REPLAY_QA_API_BASE: `http://127.0.0.1:${site.address().port}/api/v1`, REPLAY_QA_LIVE_DIR: directory }, stdio: ['ignore', 'pipe', 'pipe'] })
let stderr = ''
child.stderr.on('data', chunk => { stderr += chunk })
try {
  const info = await new Promise((resolve, reject) => {
    let out = ''
    child.stdout.on('data', chunk => { out += chunk; if (out.includes('\n')) resolve(JSON.parse(out.split('\n')[0])) })
    child.on('exit', code => reject(new Error(`relay exit ${code}: ${stderr}`)))
    setTimeout(() => reject(new Error('relay did not start')), 10000).unref()
  })
  const call = async (route, body) => {
    const res = await fetch(`http://127.0.0.1:${info.port}${route}?token=${info.token}`, body ? { method: 'POST', body: JSON.stringify(body) } : {})
    const data = await res.json()
    if (!res.ok) throw new Error(JSON.stringify(data))
    return data
  }
  await call('/canvas/proj-bench/view', { width: 1000, height: 700 })
  await sleep(1000)
  const initial = (await call('/frames')).frames['canvas-proj-bench'].generation
  const start = performance.now()
  await sleep(3000)
  const final = (await call('/frames')).frames['canvas-proj-bench'].generation
  const frameRate = (final - initial) / ((performance.now() - start) / 1000)
  const began = performance.now()
  let requests = 0
  const send = input => { requests++; return call('/canvas/proj-bench/input', input) }
  const inputs = Array.from({ length: 100 }, (_, i) => ({ type: 'pointer', event: 'move', x: i / 100, y: 0.75 }))
  for (const event of ['down', 'up']) inputs.push({ type: 'pointer', event, button: 'left', x: 0.25, y: 0.25 })
  if (process.argv.includes('--coalesced')) {
    const queue = createDashboardQueue({ sendInput: send })
    for (const [i, input] of inputs.entries()) queue.push({ type: 'batch', stream: 'bench', events: [{ seq: i + 1, input }] })
    await queue.idle()
  } else {
    let queue = Promise.resolve()
    for (const input of inputs) queue = queue.then(() => send(input))
    await queue
  }
  const end = performance.now() + 2000
  while (!clickedAt && performance.now() < end) await sleep(5)
  if (!clickedAt) throw new Error('click did not reach browser')
  const burstLatency = clickedAt - began
  const clickLatencies = []
  for (let i = 0; i < 10; i++) {
    clickedAt = 0
    const startClick = performance.now()
    await send({ type: 'batch', stream: 'single-click', events: ['down', 'up'].map((event, n) => ({ seq: i * 2 + n + 1, input: { type: 'pointer', event, button: 'left', x: 0.25, y: 0.25 } })) })
    const deadline = performance.now() + 2000
    while (!clickedAt && performance.now() < deadline) await sleep(2)
    if (!clickedAt) throw new Error('single click did not reach browser')
    clickLatencies.push(clickedAt - startClick)
  }
  clickLatencies.sort((a,b) => a-b)
  console.log(JSON.stringify({ published_fps: +frameRate.toFixed(1), burst_to_click_ms: +burstLatency.toFixed(1), burst_input_requests: requests - 10, click_median_ms: +clickLatencies[5].toFixed(1), click_p95_ms: +clickLatencies[9].toFixed(1) }))
} finally {
  if (child.exitCode === null) { child.kill(); await new Promise(resolve => child.once('exit', resolve)) }
  await new Promise(resolve => site.close(resolve))
  await fs.rm(directory, { recursive: true, force: true })
}
