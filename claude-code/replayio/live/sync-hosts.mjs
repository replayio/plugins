// Copies the rrweb runtime from claude-code/replayio to the other hosts' plugins, each of which
// installs on its own. This folder is the source of truth; --check fails if a copy has drifted.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const repo = path.resolve(here, '..', '..', '..')

const RUNTIME = ['relay.mjs', 'rrweb.mjs', 'detect.mjs', 'player.html', 'tracer.js', 'vendor/rrweb.min.js', 'vendor/rrweb.min.css']
const SCRIPTS = ['browser-open.js', 'browser-close.js']
const HOSTS = [
  { live: 'codex/replayio/live', scripts: 'codex/replayio/scripts' },
  { live: 'cursor/replayio/live', scripts: 'cursor/replayio/scripts' },
  { live: 'opencode/replayio/.opencode/replayio-live', scripts: null },
]

const pairs = HOSTS.flatMap(host => [
  ...RUNTIME.map(file => [path.join(here, file), path.join(repo, host.live, file)]),
  ...(host.scripts ? SCRIPTS.map(file => [path.join(here, '..', 'scripts', file), path.join(repo, host.scripts, file)]) : []),
])

if (process.argv.includes('--check')) {
  const stale = pairs.filter(([from, to]) => !fs.existsSync(to) || !fs.readFileSync(from).equals(fs.readFileSync(to)))
  for (const [, to] of stale) console.error(`out of date: ${path.relative(repo, to)}`)
  process.exit(stale.length ? 1 : 0)
}

for (const [from, to] of pairs) {
  fs.mkdirSync(path.dirname(to), { recursive: true })
  fs.copyFileSync(from, to)
}
console.log(`Copied the rrweb runtime to ${HOSTS.length} hosts.`)
