// node --test live/test/
import test from 'node:test'
import assert from 'node:assert/strict'

import { apiBaseOf, tunnelServers } from '../qa-stream.mjs'

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
