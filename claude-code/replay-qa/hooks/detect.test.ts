import { expect, test } from 'claude-code/testing'

import { isRunningStatus, jsonValues, parseQaCommand, parseQaOutput } from './detect.ts'

const SCRIPTS = '${CLAUDE_PLUGIN_ROOT:-.claude/skills/replay-qa}/skills/replay-qa/scripts'

test('recognizes the scripts that start or follow QA work', () => {
  expect(parseQaCommand(`node "${SCRIPTS}/start-exploration.js" --project-id proj-shop-1 --prompt "Explore checkout"`)).toEqual({
    script: 'start-exploration', projectId: 'proj-shop-1', startsRun: false,
  })
  expect(parseQaCommand('node /x/skills/replay-qa/scripts/status.js --watch')).toEqual({ script: 'status', startsRun: false })
  expect(parseQaCommand('node full-qa.js proj-abc')).toEqual({ script: 'full-qa', projectId: 'proj-abc', startsRun: false })
})

test('a bug marked fixed, a bug-id re-run and a missing-bug report start a run', () => {
  expect(parseQaCommand('node scripts/mark-bug.js bug-12 fixed --project-id proj-a')).toEqual({
    script: 'mark-bug', projectId: 'proj-a', bugId: 'bug-12', bugStatus: 'fixed', startsRun: true,
  })
  expect(parseQaCommand('node scripts/mark-bug.js bug-12')).toEqual({ script: 'mark-bug', bugId: 'bug-12', bugStatus: 'fixed', startsRun: true })
  expect(parseQaCommand('node scripts/mark-bug.js bug-12 wontfix')).toEqual({ script: 'mark-bug', bugId: 'bug-12', bugStatus: 'wontfix', startsRun: false })
  expect(parseQaCommand('node scripts/rerun-journeys.js --bug-id=bug-9')).toEqual({ script: 'rerun-journeys', bugId: 'bug-9', startsRun: true })
  expect(parseQaCommand('node scripts/rerun-journeys.js --journey-id j1')).toEqual({ script: 'rerun-journeys', startsRun: false })
  expect(parseQaCommand('node scripts/report-missing-bug.js "Cart total is wrong"')).toEqual({ script: 'report-missing-bug', startsRun: true })
})

test('follows the script through a variable, an env prefix and a chain', () => {
  const viaVariable = `SCRIPT="${SCRIPTS}/start-exploration.js"\nnode "$SCRIPT" --prompt "x" --project-id proj-v`
  expect(parseQaCommand(viaVariable)).toEqual({ script: 'start-exploration', projectId: 'proj-v', startsRun: false })
  expect(parseQaCommand('REPLAY_QA_PROJECT_ID=proj-env node scripts/start-exploration.js --prompt "x"')).toEqual({
    script: 'start-exploration', projectId: 'proj-env', startsRun: false,
  })
  expect(parseQaCommand('cd app && node scripts/status.js --project proj-c; echo done')).toEqual({ script: 'status', projectId: 'proj-c', startsRun: false })
})

test('does not mistake reading or naming a script for running it', () => {
  expect(parseQaCommand('cat skills/replay-qa/scripts/start-exploration.js')).toBe(null)
  expect(parseQaCommand(`SCRIPT="${SCRIPTS}/start-exploration.js"`)).toBe(null)
  expect(parseQaCommand('grep -n mark-bug.js README.md')).toBe(null)
  expect(parseQaCommand('git status')).toBe(null)
})

const EXPLORATION = JSON.stringify({
  id: 'expl-1790619759515-urv2cauz', project_id: 'proj-blamy-github-io-mtlu444c', prompt: 'Explore checkout',
  status: 'in-progress', journeys_created: 0, journeys_updated: 0, started_at: '2026-10-14T10:00:00.000Z',
}, null, 2)

test('reads a started exploration from the script output', () => {
  expect(parseQaOutput(EXPLORATION)).toEqual({
    projectId: 'proj-blamy-github-io-mtlu444c', explorationId: 'expl-1790619759515-urv2cauz', explorationStatus: 'in-progress',
    prompt: 'Explore checkout', runIds: [], seenExplorationIds: ['expl-1790619759515-urv2cauz'],
  })
  expect(isRunningStatus('in-progress')).toBe(true)
  expect(isRunningStatus('completed')).toBe(false)
})

test('tolerates prose around the JSON and sections printed by printSection', () => {
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
