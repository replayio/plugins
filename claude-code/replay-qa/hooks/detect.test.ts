import { expect, test } from 'claude-code/testing'

import { isRunningStatus, jsonValues, parseQaCommand, parseQaOutput } from './detect.ts'

const QA = 'npx --yes replayqa@0.4.0'

test('recognizes the commands that start or follow QA work', () => {
  expect(parseQaCommand(`${QA} start-exploration --project-id proj-shop-1 --prompt "Explore checkout"`)).toEqual({
    verb: 'start-exploration', projectId: 'proj-shop-1', startsRun: false,
  })
  expect(parseQaCommand(`${QA} status --watch`)).toEqual({ verb: 'status', startsRun: false })
  expect(parseQaCommand(`${QA} full-qa proj-abc`)).toEqual({ verb: 'full-qa', projectId: 'proj-abc', startsRun: false })
})

test('however the CLI is run', () => {
  for (const cli of ['replayqa', 'npx replayqa', 'npx -y replayqa@latest', 'npx --package replayqa replayqa', 'npx --package=replayqa@1.0.0 replayqa', 'bunx replayqa', 'pnpm dlx replayqa', 'npm exec replayqa', '/usr/local/bin/replayqa', './node_modules/.bin/replayqa']) {
    expect(parseQaCommand(`${cli} status --project proj-x`)).toEqual({ verb: 'status', projectId: 'proj-x', startsRun: false })
  }
})

test('a bug marked fixed, a bug-id re-run and a missing-bug report start a run', () => {
  expect(parseQaCommand(`${QA} mark-bug bug-12 fixed --project-id proj-a`)).toEqual({
    verb: 'mark-bug', projectId: 'proj-a', bugId: 'bug-12', bugStatus: 'fixed', startsRun: true,
  })
  expect(parseQaCommand(`${QA} mark-bug bug-12`)).toEqual({ verb: 'mark-bug', bugId: 'bug-12', bugStatus: 'fixed', startsRun: true })
  expect(parseQaCommand(`${QA} mark-bug bug-12 wontfix`)).toEqual({ verb: 'mark-bug', bugId: 'bug-12', bugStatus: 'wontfix', startsRun: false })
  expect(parseQaCommand(`${QA} rerun-journeys --bug-id=bug-9`)).toEqual({ verb: 'rerun-journeys', bugId: 'bug-9', startsRun: true })
  expect(parseQaCommand(`${QA} rerun-journeys --journey-id j1`)).toEqual({ verb: 'rerun-journeys', startsRun: false })
  expect(parseQaCommand(`${QA} report-missing-bug "Cart total is wrong"`)).toEqual({ verb: 'report-missing-bug', startsRun: true })
})

test('follows the CLI through a variable, a function, an env prefix and a chain', () => {
  expect(parseQaCommand(`QA="${QA}"\n$QA start-exploration --prompt "x" --project-id proj-v`)).toEqual({ verb: 'start-exploration', projectId: 'proj-v', startsRun: false })
  expect(parseQaCommand(`qa(){ ${QA} "$@"; }; qa status --project proj-f`)).toEqual({ verb: 'status', projectId: 'proj-f', startsRun: false })
  expect(parseQaCommand(`REPLAY_QA_PROJECT_ID=proj-env ${QA} start-exploration --prompt "x"`)).toEqual({
    verb: 'start-exploration', projectId: 'proj-env', startsRun: false,
  })
  expect(parseQaCommand(`cd app && ${QA} status --project proj-c; echo done`)).toEqual({ verb: 'status', projectId: 'proj-c', startsRun: false })
  expect(parseQaCommand(`${QA} status --project proj-c | head -20`)?.verb).toBe('status')
  expect(parseQaCommand(`if true; then ${QA} status; fi`)?.verb).toBe('status')
})

test('does not mistake reading or naming the CLI for running it', () => {
  expect(parseQaCommand('grep replayqa README.md')).toBe(null)
  expect(parseQaCommand('cat node_modules/.bin/replayqa')).toBe(null)
  expect(parseQaCommand(`QA="${QA} status"`)).toBe(null)
  expect(parseQaCommand('echo npx replayqa status')).toBe(null)
  expect(parseQaCommand('git commit -m "replayqa status"')).toBe(null)
  expect(parseQaCommand('git status')).toBe(null)
})

test('verbs the live views do not follow', () => {
  for (const verb of ['bugs', 'context', 'login', 'doctor', 'recording-events run-1 --follow', 'run http://localhost:3000']) {
    expect(parseQaCommand(`${QA} ${verb}`)).toBe(null)
  }
})

const EXPLORATION = JSON.stringify({
  id: 'expl-1790619759515-urv2cauz', project_id: 'proj-blamy-github-io-mtlu444c', prompt: 'Explore checkout',
  status: 'in-progress', journeys_created: 0, journeys_updated: 0, started_at: '2026-10-14T10:00:00.000Z',
}, null, 2)

test('reads a started exploration from the output', () => {
  expect(parseQaOutput(EXPLORATION)).toEqual({
    projectId: 'proj-blamy-github-io-mtlu444c', explorationId: 'expl-1790619759515-urv2cauz', explorationStatus: 'in-progress',
    prompt: 'Explore checkout', runIds: [], seenExplorationIds: ['expl-1790619759515-urv2cauz'],
  })
  expect(isRunningStatus('in-progress')).toBe(true)
  expect(isRunningStatus('completed')).toBe(false)
})

test('tolerates prose around the JSON and sections', () => {
  const text = `Starting…\n\n=== Replay QA project ===\n{\n  "project_id": "proj-x1",\n  "source": "config"\n}\n\n=== Project status ===\n${JSON.stringify({ explorations: [{ id: 'expl-old', status: 'completed' }], test_runs: [{ id: 'run-1', status: 'in-progress' }] }, null, 2)}\nDone.`
  const out = parseQaOutput(text)
  expect(out.projectId).toBe('proj-x1')
  // An exploration listed in a status is not one just started.
  expect(out.explorationId).toBe(undefined)
  expect(out.seenExplorationIds).toEqual(['expl-old'])
  expect(out.runIds).toEqual(['run-1'])
})

test('reads a bug record and falls back to ids in plain text', () => {
  const bug = parseQaOutput(JSON.stringify({ id: 'bug-1', journey_id: 'j3', status: 'fixed', title: 'Card form rejects valid numbers' }))
  expect(bug.bugId).toBe('bug-1')
  expect(bug.journeyId).toBe('j3')
  const prose = parseQaOutput('Started expl-abc123 for proj-p9 (run-7 queued)')
  expect(prose.projectId).toBe('proj-p9')
  expect(prose.seenExplorationIds).toEqual(['expl-abc123'])
  expect(prose.runIds).toEqual(['run-7'])
  expect(parseQaOutput('nothing relevant here')).toEqual({ runIds: [], seenExplorationIds: [] })
})

test('finds JSON values with braces and escaped quotes inside strings', () => {
  const values = jsonValues('lead\n{ "a": "x } \\" y", "n": [1, {"b": 2}] }\ntail')
  expect(values).toEqual([{ a: 'x } " y', n: [1, { b: 2 }] }])
})

test('notices a QA server other than the default', () => {
  expect(parseQaCommand(`REPLAY_QA_API_BASE=https://pr-1--qa.netlify.app/api/v1 ${QA} status proj-a`)).toEqual({
    verb: 'status', projectId: 'proj-a', startsRun: false, server: 'https://pr-1--qa.netlify.app/api/v1',
  })
  expect(parseQaCommand(`export REPLAY_QA_URL=https://pr-1--qa.netlify.app && ${QA} full-qa`)?.server).toBe('https://pr-1--qa.netlify.app')
  const runbook = parseQaOutput('```sh\nnpx --yes replayqa proxy --project proj-a --qa-url https://pr-1--qa.netlify.app\n```')
  expect(runbook.qaUrl).toBe('https://pr-1--qa.netlify.app')
  expect(runbook.projectId).toBe('proj-a')
})
