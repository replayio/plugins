import { expect, test } from 'claude-code/testing'

import { closedSessions, endCwd, openedSessions, parseBrowserCommands, withOutput } from './detect.ts'

const pw = (kind: 'open' | 'close', session: string | null, cwd: string | null = null) => ({ tool: 'playwright-cli', kind, session, cwd })
const ab = (kind: 'open' | 'close', session: string, cwd: string | null = null) => ({ tool: 'agent-browser', kind, session, cwd })

test('recognizes playwright-cli open and close with each session spelling', () => {
  expect(parseBrowserCommands('npx --yes --package @playwright/cli playwright-cli -s=rt open http://localhost:3000')).toEqual([pw('open', 'rt')])
  expect(parseBrowserCommands('"$PWCLI" --session rt close')).toEqual([pw('close', 'rt')])
  expect(parseBrowserCommands('playwright-cli --session="rt2" open "$URL" --headed')).toEqual([pw('open', 'rt2')])
})

test('recognizes the package invoked directly, and wrappers around it', () => {
  expect(parseBrowserCommands('npx -y @playwright/cli open http://localhost:8791/index.html')).toEqual([pw('open', null)])
  // The exact shapes an agent wrote: a shell function, then calls through it and a pipe.
  const wrapper = 'cd /tmp/demo; export RECORD_ALL_CONTENT=1\npw(){ npx -y @playwright/cli "$@"; }\npw open http://localhost:8791/index.html 2>&1 | tail -15\npw snapshot 2>&1 | tail -15'
  expect(parseBrowserCommands(wrapper, '/work')).toEqual([pw('open', null, '/tmp/demo')])
  // A variable holding the CLI.
  expect(parseBrowserCommands('P="npx -y @playwright/cli"\n$P open http://x\n$P close')).toEqual([pw('open', null), pw('close', null)])
  expect(parseBrowserCommands("alias pwc='playwright-cli'; pwc -s=a open http://x")).toEqual([pw('open', 'a')])
})

test('leaves shell-variable sessions unresolved', () => {
  expect(parseBrowserCommands('"$PWCLI" --session="$SESSION" open "$URL"')).toEqual([pw('open', null)])
})

test('ignores other verbs and unrelated commands', () => {
  expect(parseBrowserCommands('"$PWCLI" --session=rt snapshot')).toEqual([])
  expect(parseBrowserCommands('git commit -m "open the browser"')).toEqual([])
  expect(parseBrowserCommands('npm run open')).toEqual([])
  expect(parseBrowserCommands('agent-browser fill @e2 "Ada"; agent-browser click @e4')).toEqual([])
})

test('finds commands inside chains and the lifecycle scripts', () => {
  expect(parseBrowserCommands('cd app && node "$SCRIPT_DIR/browser-open.js" "$URL" --session qa1 && echo ok')).toEqual([pw('open', 'qa1')])
  expect(parseBrowserCommands('node scripts/browser-close.js --session qa1; replayio list')).toEqual([pw('close', 'qa1')])
})

test('recognizes agent-browser, skipping the values of its flags', () => {
  const open = 'EXE=~/.replay/runtimes/Replay-Chromium.app/Contents/MacOS/Chromium\nexport RECORD_ALL_CONTENT=1\nagent-browser close >/dev/null 2>&1\nagent-browser --executable-path $EXE open http://localhost:8791/index.html 2>&1 | tail -3'
  expect(parseBrowserCommands(open)).toEqual([ab('close', 'default'), ab('open', 'default')])
  expect(parseBrowserCommands('agent-browser --session qa --executable-path /x/chromium open http://x')).toEqual([ab('open', 'qa')])
  expect(parseBrowserCommands('AGENT_BROWSER_SESSION=work agent-browser open http://x')).toEqual([ab('open', 'work')])
  expect(parseBrowserCommands('agent-browser close --all')).toEqual([{ ...ab('close', 'default'), all: true }])
})

test('follows cd, so the tracer is injected from the directory the browser opened in', () => {
  const open = 'npx --yes --package @playwright/cli playwright-cli --session=d open http://localhost:3000'
  expect(parseBrowserCommands(`cd /tmp && RECORD_ALL_CONTENT=1 ${open}`, '/work/app')).toEqual([pw('open', 'd', '/tmp')])
  expect(parseBrowserCommands(`cd demo/site && ${open}`, '/work/app')).toEqual([pw('open', 'd', '/work/app/demo/site')])
  expect(parseBrowserCommands(`cd ../other; ${open}`, '/work/app')).toEqual([pw('open', 'd', '/work/other')])
  expect(parseBrowserCommands(open, '/work/app')).toEqual([pw('open', 'd', '/work/app')])
  expect(parseBrowserCommands(`cd "$APP" && ${open}`, '/work/app')).toEqual([pw('open', 'd', null)])
  expect(parseBrowserCommands(`cd ~/proj && ${open}`, '/work/app')).toEqual([pw('open', 'd', null)])
  expect(endCwd('cd /tmp/demo; export A=1\nwhatever', '/work')).toBe('/tmp/demo')
})

test('reads the session names the output reports', () => {
  expect(openedSessions('### Browser `rt2` opened with pid 71956.\n### Page')).toEqual(['rt2'])
  expect(openedSessions('{\n  "playwright_session": "replayio-17",\n  "url": "x"\n}')).toEqual(['replayio-17'])
  expect(closedSessions("Browser 'rt2' closed")).toEqual(['rt2'])
})

test('falls back to the output when the command text hides the CLI', () => {
  const output = '### Browser `default` opened with pid 9219.\n### Ran Playwright code'
  expect(withOutput([], output, '/tmp/demo')).toEqual([pw('open', 'default', '/tmp/demo')])
  expect(withOutput([], "Browser 'x' closed", '/w')).toEqual([pw('close', 'x', '/w')])
  // Text that already showed the open is left alone.
  const shown = parseBrowserCommands('playwright-cli -s=a open http://x', '/w')
  expect(withOutput(shown, '### Browser `a` opened with pid 1.', '/w')).toEqual(shown)
})
