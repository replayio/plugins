// node --test live/test/pin.test.mjs
// A plugin uses one pinned CLI throughout: its hooks, skill and relay are written against that version.
import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..')

test('one replayqa version in each plugin, and no script left behind', () => {
  const grep = (pattern, ...where) => execFileSync('git', ['grep', '-h', '-o', '-E', pattern, '--', ...where, ':!*/test/*', ':!*.test.ts', ':!*.test.tsx'], { cwd: repo, encoding: 'utf8' })
  for (const plugin of ['claude-code/replay-qa', 'codex/replay-qa']) {
    const versions = new Set(grep('replayqa@[0-9][^ `"\']*', plugin).trim().split('\n'))
    assert.equal(versions.size, 1, `${plugin} has ${[...versions].join(', ')}`)
    assert.throws(() => grep('replayqa@latest', plugin), 'a release must not change a plugin by itself')
    assert.throws(() => grep('scripts/[a-z-]+\\.js', plugin), 'no skill or command should name a script')
  }
})
