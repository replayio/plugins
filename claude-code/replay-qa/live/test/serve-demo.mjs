#!/usr/bin/env node
// Starts the mock QA API (no credits) and the real relay, and prints how to reach them:
//   node live/test/serve-demo.mjs            # then open the printed canvas URL in a browser
// Press Ctrl-C to stop. Env: DEMO_PORT (relay port), DEMO_DIR (relay data dir).
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

import { startMock } from './mock-qa-api.mjs'
import { synthEvents } from './synth.mjs'

const RELAY = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'relay.mjs')
const names = ['Sign up with email', 'Log in and out', 'Add an item to the cart', 'Checkout with a saved card', 'Search the catalog', 'Edit profile', 'Contact support', 'Apply a coupon']
const statuses = ['completed', 'completed', 'completed', 'failed', 'completed', 'incomplete', 'in-progress', 'in-progress']

const projects = [{
  id: 'proj-demo-shop',
  name: 'Demo Shop',
  journeys: [...names, 'Never run yet'].map((name, i) => ({ id: `j${i}`, name })),
  bugs: [{ id: 'bug-1', journey_id: 'j3', status: 'open', title: 'Card form rejects valid numbers' }],
  runs: names.map((title, i) => ({
    id: `run-${i}`, journey_id: `j${i}`, title, status: statuses[i], bugs: i === 3 ? 1 : 0,
    events: synthEvents({ title, steps: 24 + i * 6, stepMs: statuses[i] === 'in-progress' ? 250 : 400, startTs: 1_700_000_000_000 + i * 100_000 }),
    live: statuses[i] === 'in-progress' ? { perSecond: 4 } : undefined,
  })),
  explorations: [
    { id: 'expl-live', status: 'in-progress', prompt: 'Explore the shop and test the main features', events: synthEvents({ title: 'Exploration', steps: 90, stepMs: 300 }), live: { perSecond: 3 } },
    { id: 'expl-done', status: 'completed', prompt: 'Check the checkout flow', events: synthEvents({ title: 'Checkout exploration', steps: 30 }) },
  ],
}]

const mock = await startMock({ projects })
const dataDir = process.env.DEMO_DIR || fs.mkdtempSync(path.join(os.tmpdir(), 'qa-demo-'))
const child = spawn('node', [RELAY], {
  env: { ...process.env, REPLAY_QA_API_BASE: mock.url, REPLAY_QA_API_KEY: 'demo', REPLAY_QA_LIVE_DIR: dataDir, REPLAY_QA_LIVE_PORT: process.env.DEMO_PORT ?? '0' },
  stdio: ['ignore', 'pipe', 'inherit'],
})
child.stdout.once('data', chunk => {
  const { port, token } = JSON.parse(String(chunk).split('\n')[0])
  const base = `http://127.0.0.1:${port}`
  console.log(JSON.stringify({ relay: base, token, api: mock.url, dataDir, project: 'proj-demo-shop' }))
  console.error(`canvas : ${base}/canvas/proj-demo-shop?token=${token}`)
  console.error(`player : ${base}/player/run-0?mode=auto&chrome=1&token=${token}   (after /qa/watch of run-0)`)
  console.error(`api    : ${mock.url}   (start an exploration: POST /projects/proj-demo-shop/explorations)`)
})
const stop = () => { child.kill(); void mock.close().then(() => process.exit(0)) }
process.on('SIGINT', stop)
process.on('SIGTERM', stop)
child.on('exit', () => process.exit(0))
