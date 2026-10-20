import { expect, test } from 'claude-code/testing'

import { cardFor, replayToolName, resultText } from './cards.ts'
import { FIXTURES } from './fixtures.ts'
import { PARSERS } from './tools/index.ts'

test('recognizes Replay MCP tools from the plugin and from a hand-added server', () => {
  expect(replayToolName('mcp__plugin_replayio_replay__ConsoleMessages')).toBe('ConsoleMessages')
  expect(replayToolName('mcp__replay__GetStack')).toBe('GetStack')
  expect(replayToolName('mcp__replay-qa__list_bugs')).toBe(null)
  expect(replayToolName('Bash')).toBe(null)
})

test('reads result text from strings, content blocks and { content }', () => {
  expect(resultText('a')).toBe('a')
  expect(resultText([{ type: 'text', text: 'a' }, { type: 'image' }, { type: 'text', text: 'b' }])).toBe('a\n\nb')
  expect(resultText({ content: [{ type: 'text', text: 'c' }] })).toBe('c')
})

test('every tool the server lists has a card of its own', () => {
  const tools = new Set(Object.values(FIXTURES).map(f => f.tool))
  for (const tool of tools) expect(Boolean(PARSERS[tool])).toBe(true)
})

test('every recorded output becomes a card with a first view', () => {
  for (const [name, f] of Object.entries(FIXTURES)) {
    const card = cardFor(f.tool, f.input, f.text, f.isError)
    expect({ name, title: card.title.length > 0 }).toEqual({ name, title: true })
    // A card with content shows something before any section is opened.
    const hasFirstView = card.preview.length > 0 || card.facts.length > 0 || card.status === 'empty'
    expect({ name, hasFirstView }).toEqual({ name, hasFirstView: true })
    // Every card leads somewhere: Replay, a next step for Claude, or a copy.
    expect({ name, hasActions: card.actions.length > 0 }).toEqual({ name, hasActions: true })
  }
})

test('tools that found nothing say so calmly', () => {
  for (const tool of ['UncaughtException', 'ReactException']) {
    expect(cardFor(tool, { recordingId: 'r' }, '', false).status).toBe('empty')
  }
  expect(cardFor('ZustandStores', { recordingId: 'r' }, '[InputValidation] Zustand was not found in this recording.', true).status).toBe('empty')
  expect(cardFor('RecordingOverview', { recordingId: 'r' }, '[Error] Access denied', true).status).toBe('error')
})
