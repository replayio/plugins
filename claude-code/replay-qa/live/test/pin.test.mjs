// node --test live/test/pin.test.mjs
// Every plugin must use the same pinned CLI: hooks/detect.ts and the relay are written against it.
import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..')

test('one replayqa version everywhere, and no script left behind', () => {
  const grep = pattern => execFileSync('git', ['grep', '-h', '-o', '-E', pattern, '--', 'claude-code/replay-qa', 'codex/replay-qa', ':!*/test/*', ':!*.test.ts'], { cwd: repo, encoding: 'utf8' })
  const versions = new Set(grep('replayqa@[0-9][^ `"\']*').trim().split('\n'))
  assert.equal(versions.size, 1, `found ${[...versions].join(', ')}`)
  assert.throws(() => grep('scripts/[a-z-]+\\.js'), 'no skill or command should name a script')
})
