import { expect, test } from 'claude-code/testing'

import { closedSessions, openedSessions, parseBrowserCommands } from './detect.ts'

test('recognizes playwright-cli open and close with each session spelling', () => {
  expect(parseBrowserCommands('npx --yes --package @playwright/cli playwright-cli -s=rt open http://localhost:3000')).toEqual([
    { kind: 'open', session: 'rt', cwd: null },
  ])
  expect(parseBrowserCommands('"$PWCLI" --session rt close')).toEqual([{ kind: 'close', session: 'rt', cwd: null }])
  expect(parseBrowserCommands('playwright-cli --session="rt2" open "$URL" --headed')).toEqual([
    { kind: 'open', session: 'rt2', cwd: null },
  ])
})

test('leaves shell-variable sessions unresolved', () => {
  expect(parseBrowserCommands('"$PWCLI" --session="$SESSION" open "$URL"')).toEqual([{ kind: 'open', session: null, cwd: null }])
})

test('ignores other playwright-cli verbs and unrelated commands', () => {
  expect(parseBrowserCommands('"$PWCLI" --session=rt snapshot')).toEqual([])
  expect(parseBrowserCommands('git commit -m "open the browser"')).toEqual([])
  expect(parseBrowserCommands('npm run open')).toEqual([])
})

test('finds commands inside chains and the lifecycle scripts', () => {
  expect(parseBrowserCommands('cd app && node "$SCRIPT_DIR/browser-open.js" "$URL" --session qa1 && echo ok')).toEqual([
    { kind: 'open', session: 'qa1', cwd: null },
  ])
  expect(parseBrowserCommands('node scripts/browser-close.js --session qa1; replayio list')).toEqual([
    { kind: 'close', session: 'qa1', cwd: null },
  ])
})

test('reads the session names the output reports', () => {
  expect(openedSessions('### Browser `rt2` opened with pid 71956.\n### Page')).toEqual(['rt2'])
  expect(openedSessions('{\n  "playwright_session": "replayio-17",\n  "url": "x"\n}')).toEqual(['replayio-17'])
  expect(closedSessions("Browser 'rt2' closed")).toEqual(['rt2'])
})

test('follows cd, so the tracer is injected from the directory the browser opened in', () => {
  const open = 'npx --yes --package @playwright/cli playwright-cli --session=d open http://localhost:3000'
  expect(parseBrowserCommands(`cd /tmp && RECORD_ALL_CONTENT=1 ${open}`, '/work/app')).toEqual([{ kind: 'open', session: 'd', cwd: '/tmp' }])
  expect(parseBrowserCommands(`cd demo/site && ${open}`, '/work/app')).toEqual([{ kind: 'open', session: 'd', cwd: '/work/app/demo/site' }])
  expect(parseBrowserCommands(`cd ../other; ${open}`, '/work/app')).toEqual([{ kind: 'open', session: 'd', cwd: '/work/other' }])
  expect(parseBrowserCommands(open, '/work/app')).toEqual([{ kind: 'open', session: 'd', cwd: '/work/app' }])
  expect(parseBrowserCommands(`cd "$APP" && ${open}`, '/work/app')).toEqual([{ kind: 'open', session: 'd', cwd: null }])
  expect(parseBrowserCommands(`cd ~/proj && ${open}`, '/work/app')).toEqual([{ kind: 'open', session: 'd', cwd: null }])
})
