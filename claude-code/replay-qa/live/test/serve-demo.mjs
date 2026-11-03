#!/usr/bin/env node
// Starts the mock QA API (no credits) and the real relay, and prints how to reach them:
//   node live/test/serve-demo.mjs            # then open the printed URLs in a browser
// Press Ctrl-C to stop. Env: DEMO_PORT (relay port), DEMO_DIR (relay data dir), DEMO_VIEW (index, the
// default; setup; none, a folder with nothing in it; or nodetect, one the CLI could not look at), and
// REPLAY_QA_CLI to read recordings with a checkout of the CLI. It stands in for the hooks module: the
// folder view shows what `replayqa detect` would say, and Start plays a fake tunnel (test/fake-replayqa.mjs).
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

const setupOf = (rel, name, port, source, why, command, shared = []) => {
  const cwd = `/demo/ui/${rel}`
  const appCommand = `cd ../.. && ${command}`
  const targetUrl = `http://localhost:${port}`
  return {
    path: rel, name, kind: 'app', why, dev_command: command, port, port_source: source, ...(shared.length ? { port_shared_with: shared } : {}),
    setup: {
      target_url: targetUrl, cwd, args: ['run', targetUrl, '--app-command', appCommand, '--create-project', '--name', name],
      command: `cd ${rel} && npx --yes replayqa run ${targetUrl} --app-command '${appCommand}' --create-project --name ${name}`, config_path: `${rel}/.replay/config.json`,
    },
  }
}
const noWorkspace = { tools: [], package_manager: null }
const FOLDERS = {
  index: {
    view: 'index',
    folder: {
      root: '/demo/ui', name: 'ui', mode: 'configured', workspace: noWorkspace, apps: [], packages: 0, libraries: 0,
      projects: [
        { project_id: 'proj-demo-shop', path: 'apps/shop', qa_url: null },
        { project_id: 'proj-demo-missing', path: 'apps/admin', qa_url: null },
        { project_id: 'proj-demo-preview', path: 'apps/docs', qa_url: 'https://pr-7162--loop-qa-j63k5x.netlify.app' },
      ],
    },
  },
  setup: {
    view: 'setup',
    folder: {
      root: '/demo/ui', name: 'ui', mode: 'workspace', projects: [], workspace: { tools: ['nx', 'pnpm'], package_manager: 'pnpm', root: '/demo/ui' }, packages: 5, libraries: 2,
      apps: [
        setupOf('apps/docs', '@x/docs', 4206, 'vite.config.mts', 'nx inferred from @nx/vite/plugin', 'pnpm nx dev @x/docs'),
        setupOf('apps/catalog', '@x/catalog', 6006, 'storybook script', '`storybook` runs storybook', 'pnpm nx storybook @x/catalog'),
        { ...setupOf('examples/embed', 'embed', 3000, 'next default', '`dev` runs next', 'pnpm --filter embed dev'), kind: 'maybe' },
      ],
    },
  },
  none: { view: 'setup', folder: { root: '/demo/empty', name: 'empty', mode: 'none', projects: [], workspace: noWorkspace, apps: [], packages: 0, libraries: 0 } },
  nodetect: { view: 'setup', folder: null, why: "Detection isn't available yet: replayqa@0.7.0 isn't published." },
}

const mock = await startMock({ projects })
const dataDir = process.env.DEMO_DIR || fs.mkdtempSync(path.join(os.tmpdir(), 'qa-demo-'))
const FAKE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fake-replayqa.mjs')
const child = spawn('node', [RELAY], {
  env: {
    ...process.env, REPLAY_QA_API_BASE: mock.url, REPLAY_QA_API_KEY: 'demo', REPLAY_QA_LIVE_DIR: dataDir, REPLAY_QA_LIVE_PORT: process.env.DEMO_PORT ?? '0',
    REPLAY_QA_CLI: `node ${FAKE}`, FAKE_REPLAYQA_REAL: process.env.REPLAY_QA_CLI ?? 'npx --yes replayqa@0.7.0', FAKE_REPLAYQA_PROJECT: 'proj-demo-shop', FAKE_REPLAYQA_STEP_MS: '1500',
  },
  stdio: ['ignore', 'pipe', 'inherit'],
})
child.stdout.once('data', async chunk => {
  const { port, token, hookToken } = JSON.parse(String(chunk).split('\n')[0])
  const base = `http://127.0.0.1:${port}`
  const hook = (p, body) => fetch(`${base}${p}${p.includes('?') ? '&' : '?'}token=${token}`, { method: body ? 'POST' : 'GET', headers: { 'x-replay-qa-hook-token': hookToken }, body: body ? JSON.stringify(body) : undefined }).then(r => r.json())
  const folder = FOLDERS[process.env.DEMO_VIEW ?? 'index'] ?? FOLDERS.index
  await hook('/qa/folder', { why: null, signIn: 'Using your existing Replay sign-in.', ...folder })
  // What the hooks module would do with a press in the browser view: here, a fake tunnel in a temp folder.
  void (async () => {
    for (let version = -1; ;) {
      const feed = await hook(`/frames?version=${version}`).catch(() => null)
      if (!feed) return
      version = feed.version
      for (const action of feed.actions ?? []) {
        const app = folder.folder?.apps.find(item => item.setup?.cwd === action.key)
        if (action.type === 'start' && app) await hook('/tunnels', { key: app.setup.cwd, label: app.name, targetUrl: app.setup.target_url, args: app.setup.args, cwd: dataDir })
        else if (action.type === 'stop') await hook(`/tunnels/${encodeURIComponent(action.key)}/stop`, {})
        else console.error(`pressed: ${JSON.stringify(action)}`)
      }
    }
  })()
  console.log(JSON.stringify({ relay: base, token, api: mock.url, dataDir, project: 'proj-demo-shop' }))
  console.error(`folder : ${base}/folder?token=${token}   (DEMO_VIEW=index|setup|none|nodetect)`)
  console.error(`canvas : ${base}/canvas/proj-demo-shop?token=${token}`)
  console.error(`player : ${base}/player/run-0?mode=auto&chrome=1&token=${token}   (after /qa/watch of run-0)`)
  console.error(`api    : ${mock.url}   (start an exploration: POST /projects/proj-demo-shop/explorations)`)
})
const stop = () => { child.kill(); void mock.close().then(() => process.exit(0)) }
process.on('SIGINT', stop)
process.on('SIGTERM', stop)
child.on('exit', () => process.exit(0))
