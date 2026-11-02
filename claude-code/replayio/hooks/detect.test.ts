import { expect, test } from 'claude-code/testing'

import { joinDir, netEffect, openedSession, parseBrowserCommands } from './detect.ts'

const parse = (command: string, cwd: string | null = '/repo') => parseBrowserCommands(command, cwd)

test('a plain open, with and without a session', () => {
  expect(parse('agent-browser open http://x')).toEqual([{ kind: 'open', session: 'default', cwd: '/repo' }])
  expect(parse('agent-browser --session a open http://x')).toEqual([{ kind: 'open', session: 'a', cwd: '/repo' }])
  expect(parse('agent-browser --session=a open http://x')).toEqual([{ kind: 'open', session: 'a', cwd: '/repo' }])
  expect(parse('AGENT_BROWSER_SESSION=b agent-browser open http://x')).toEqual([{ kind: 'open', session: 'b', cwd: '/repo' }])
})

test('any verb that needs a browser counts: agent-browser starts one for it', () => {
  for (const verb of ['snapshot', 'click @e1', 'batch "open http://x"', 'connect 9222', 'eval "1"']) {
    expect(parse(`agent-browser -s a ${verb}`)[0]?.kind).toBe('open')
  }
})

test('verbs that never touch a browser do not', () => {
  for (const verb of ['skills get core', 'session list', 'profiles', 'install', 'open --help', '--version']) {
    expect(parse(`agent-browser ${verb}`)).toEqual([])
  }
})

test('flags with values are not verbs', () => {
  expect(parse('agent-browser --executable-path /x/Chromium open http://x')[0]?.kind).toBe('open')
  expect(parse('agent-browser --profile close open http://x')[0]?.kind).toBe('open')
})

test('close, and close --all', () => {
  expect(parse('agent-browser -s a close')).toEqual([{ kind: 'close', session: 'a', cwd: '/repo' }])
  expect(parse('agent-browser close --all')).toEqual([{ kind: 'close', session: 'default', cwd: '/repo', all: true }])
})

test('wrappers and variables', () => {
  expect(parse('ab(){ npx agent-browser "$@"; }; ab open http://x')[0]?.kind).toBe('open')
  expect(parse('AB="npx agent-browser"; $AB -s q open http://x')[0]).toEqual({ kind: 'open', session: 'q', cwd: '/repo' })
  expect(parse('npx --yes agent-browser open http://x')[0]?.kind).toBe('open')
})

test('shell structure around it', () => {
  expect(parse('if true; then agent-browser open http://x; fi')[0]?.kind).toBe('open')
  expect(parse('URL=$(agent-browser -s a get url)')).toEqual([])
  expect(parse('(agent-browser -s a open http://x)')[0]?.session).toBe('a')
  expect(parse('/opt/homebrew/bin/agent-browser -s a open http://x')[0]?.session).toBe('a')
  expect(parse('agent-browser -s a snapshot | head -5')[0]?.session).toBe('a')
})

test('a session held in a shell variable is unknown', () => {
  expect(parse('agent-browser -s "$S" open http://x')[0]?.session).toBe(null)
})

test('cd moves where later commands run', () => {
  expect(parse('cd app && agent-browser open http://x')[0]?.cwd).toBe('/repo/app')
  expect(parse('cd "$X" && agent-browser open http://x')[0]?.cwd).toBe(null)
  expect(joinDir('/a/b', '../c')).toBe('/a/c')
})

test('the lifecycle scripts', () => {
  expect(parse('node "$SCRIPT_DIR/browser-open.js" http://x --session a')).toEqual([{ kind: 'open', session: 'a', cwd: '/repo' }])
  expect(parse('node scripts/browser-close.js --session a')).toEqual([{ kind: 'close', session: 'a', cwd: '/repo' }])
  expect(openedSession('{ "agent_browser_session": "replayio-1" }')).toBe('replayio-1')
})

test('commands that only mention it do not count', () => {
  expect(parse('grep agent-browser README.md')).toEqual([])
  expect(parse('echo done')).toEqual([])
  expect(parse('rg "agent-browser open" docs')).toEqual([])
  expect(parse('git commit -m "use agent-browser open"')).toEqual([])
  expect(parse('cat scripts/agent-browser')).toEqual([])
})

test('netEffect keeps what each session ended up doing', () => {
  const opened = parse('agent-browser open http://x && agent-browser snapshot')
  expect(netEffect(opened)).toEqual([{ kind: 'open', session: 'default', cwd: '/repo' }])
  expect(netEffect(parse('agent-browser open http://x && agent-browser close'))[0]?.kind).toBe('close')
})
