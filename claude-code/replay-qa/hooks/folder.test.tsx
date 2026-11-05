import { expect, mock, test } from 'claude-code/testing'

// `/replayqa` follows the session's folder, with the relay, the CLI, the file system and the MCP server
// faked beneath the plugin. Nothing here runs `replayqa` or reaches a QA server.

const CREDENTIAL = 'mcl_c2VjcmV0LWNyZWRlbnRpYWwtdmFsdWU'
const PREVIEW = 'https://pr-7162--loop-qa-j63k5x.netlify.app'
const STALE_PROJECT = 'proj-apple-notes-opfs-pr-7162--mvqrz5qb'

const app = (over: Record<string, unknown> = {}) => ({
  path: 'apps/docs', name: '@x/docs', kind: 'app', why: 'nx inferred from @nx/vite/plugin', dev_command: 'pnpm nx dev @x/docs', port: 4206, port_source: 'vite.config.mts',
  setup: {
    target_url: 'http://localhost:4206', cwd: '/work/ui/apps/docs', cli: ['npx', '--yes', 'replayqa@0.7.0'],
    args: ['run', 'http://localhost:4206', '--app-command', 'cd ../.. && pnpm nx dev @x/docs', '--create-project', '--name', '@x/docs'],
    command: "cd apps/docs && npx --yes replayqa@0.7.0 run http://localhost:4206 --app-command 'cd ../.. && pnpm nx dev @x/docs' --create-project --name @x/docs",
    config_path: 'apps/docs/.replay/config.json',
  },
  ...over,
})

const WORKSPACE = {
  root: '/work/ui', name: 'ui', mode: 'workspace', projects: [], workspace: { tools: ['nx', 'pnpm'], package_manager: 'pnpm', root: '/work/ui' },
  apps: [app()], packages: 3, libraries: 2,
}
const configured = (...projects: { project_id: string; path: string; qa_url: string | null }[]) => ({
  root: '/work/ui', name: 'ui', mode: 'configured', projects, workspace: { tools: [], package_manager: null }, apps: [], packages: 0, libraries: 0,
})

const overviewOf = (projectId: string, error: string | null = null, server: string | null = null) => ({
  project: error ? null : { id: projectId, name: `Name of ${projectId}`, target_url: null, status: 'active' }, server, error, updatedAt: 0, following: true,
  counts: { live: 0, journeys: 3, bugs: 0, failed: 0 }, tiles: [],
})

type World = {
  cwd?: string
  /** The git repository, and where the session is in it; null outside git. */
  git?: { top: string; prefix: string } | null
  files?: Record<string, string>
  /** What `replayqa detect` prints, or how it fails. */
  detect?: unknown | { failWith: string }
  link?: { exitCode: number; stderr?: string }
  bootstrap?: { exitCode: number; stdout?: string; stderr?: string }
  store?: Record<string, unknown>
  /**
   * What the MCP server does when asked for a credential. `no-tool` is production until create_cli_credential
   * ships, as the real engine answers it: connected, and the call rejected before it leaves.
   */
  mcp?: 'gives' | 'needs-auth' | 'needs-auth-at-call' | 'no-tool' | 'cannot-share' | 'hangs'
  /** What the permission check would say to the call: plan mode's `ask`, say. */
  mcpVerdict?: 'allow' | 'ask' | 'deny'
  /** Whether the relay finds REPLAY_QA_API_KEY or a `replayqa login`. */
  existing?: boolean
  overview?: (projectId: string) => unknown
  portIsOpen?: boolean
  env?: Record<string, string>
  /** What a Bash call the plugin watches prints. */
  bash?: string
  bashAndMcp?: boolean
}

async function session($: any, on: any, world: World = {}) {
  const clock = mock.clock(on)
  const store = new Map(Object.entries(world.store ?? {}))
  on('store.get', (_: any, e: any) => ({ value: store.get(e.key) }))
  on('store.set', (_: any, e: any) => { store.set(e.key, e.value); return { value: undefined } })
  on('store.delete', (_: any, e: any) => { store.delete(e.key); return { value: undefined } })
  on('store.keys', () => ({ value: [...store.keys()] }))
  mock.env(on, world.env ?? {})
  const cwd = world.cwd ?? '/work/ui'
  const git = world.git === undefined ? { top: '/work/ui', prefix: '' } : world.git
  const files = { ...world.files }
  const relay: { path: string; body: any; headers: Record<string, string> }[] = []
  const runs: { argv: readonly string[]; init: any }[] = []
  const written: Record<string, string> = {}
  const said: string[] = []
  const minted: string[] = []
  const mcpCalls: string[] = []
  /** What the relay's frame feed answers next. */
  const feed: Record<string, unknown>[] = []
  let mcpSignedIn = false

  on('process.spawn', async function* () {
    yield { stream: 'stdout' as const, text: '{"port":4000,"token":"t","hookToken":"hook-secret"}\n' }
    await clock.sleep(1e12)
    return { code: 0, signal: null } as any
  })
  on('session.cwd', () => ({ value: cwd }))
  on('process.run', (_: any, e: any) => {
    runs.push({ argv: e.argv, init: e.init })
    const answer = (exitCode: number, stdout = '', stderr = '') => ({ value: { exitCode, stdout, stderr } })
    if (e.argv[0] === 'git') return git ? answer(0, `${git.top}\n${git.prefix}\n`) : answer(128, '', 'fatal: not a git repository')
    const verb = e.argv.find((word: string) => ['detect', 'link', 'bootstrap'].includes(word))
    if (verb === 'detect') {
      const detect = world.detect ?? WORKSPACE
      if ((detect as any).failWith) return answer(1, '', (detect as any).failWith)
      return answer(0, JSON.stringify(detect))
    }
    if (verb === 'link') return answer(world.link?.exitCode ?? 0, '{}', world.link?.stderr ?? '')
    if (verb === 'bootstrap') return answer(world.bootstrap?.exitCode ?? 0, world.bootstrap?.stdout ?? '', world.bootstrap?.stderr ?? '')
    return answer(0)
  })
  on('fs.read', (_: any, e: any) => {
    return e.path in files ? { value: files[e.path]! } : { deny: `no ${e.path}` }
  })
  on('fs.exists', (_: any, e: any) => ({ value: e.path in files }))
  on('fs.write', (_: any, e: any) => { written[e.path] = e.text; files[e.path] = e.text; return { value: undefined } })
  on('tool.check', () => ({ decision: world.mcpVerdict ?? 'allow' }) as any)
  on('mcp.connect', () => ({ value: world.mcp === 'needs-auth' ? { isConnected: false, reason: 'auth', message: 'Needs sign-in.' } : { isConnected: true, server: 'plugin:replay-qa:replay-qa' } }))
  on('mcp.call', async (_: any, e: any) => {
    mcpCalls.push(e.tool)
    if (world.mcp === 'needs-auth') return { deny: `no connected MCP tool "${e.tool}" on a server named "${e.server}"` }
    if (world.mcp === 'no-tool') return { deny: `no connected MCP tool "${e.tool}" on a server named "${e.server}"` }
    // As the real engine answered the PR preview's 401: an errored result, not a rejection.
    if (world.mcp === 'needs-auth-at-call') return { value: { isError: true, content: [{ type: 'text', text: 'MCP server "plugin:replay-qa:replay-qa" needs you to sign in again (run /mcp to re-authenticate)' }] } }
    if (world.mcp === 'cannot-share') return { value: { isError: true, content: [{ type: 'text', text: 'This connection did not sign in through OAuth, so it has no sign-in to share.' }] } }
    if (world.mcp === 'hangs') await clock.sleep(1e12)
    if (e.tool !== 'create_cli_credential') throw new Error(`unexpected tool ${e.tool}`)
    if (e.args?.code_challenge !== 'challenge-from-the-relay') throw new Error('asked without the relay\'s challenge')
    const credential = `${CREDENTIAL}${minted.length}`
    minted.push(credential)
    return { value: { isError: false, content: [{ type: 'text', text: JSON.stringify({ credential, qa_url: 'https://qa.replay.io', expires_in: 600 }) }] } }
  })
  on('http.fetch', (_: any, e: any) => {
    const url = new URL(e.url)
    const body = e.init?.body ? JSON.parse(String(e.init.body)) : undefined
    relay.push({ path: url.pathname, body, headers: e.init?.headers ?? {} })
    const answer = (value: unknown, status = 200) => ({ value: { status, ok: status < 300, headers: {}, text: JSON.stringify(value) } })
    const project = body?.projectId ?? url.searchParams.get('project')
    if (url.pathname === '/auth/challenge') return answer({ code_challenge: 'challenge-from-the-relay' })
    if (url.pathname === '/auth/status') return answer({ mcp: mcpSignedIn ? [{ origin: 'https://qa.replay.io', expiresAt: 1e15 }] : [], existing: world.existing === true })
    if (url.pathname === '/auth/credential') { mcpSignedIn = true; return answer({ origin: 'https://qa.replay.io', expiresAt: 1e15 }) }
    if (url.pathname === '/auth/mint') return answer(mcpSignedIn ? { credential: `${CREDENTIAL}relay`, qaUrl: 'https://qa.replay.io' } : { credential: null, qaUrl: null })
    if (url.pathname === '/qa/follow' || url.pathname === '/qa/overview') return answer(world.overview?.(project) ?? overviewOf(project))
    if (url.pathname === '/qa/folder') return e.init?.method === 'POST' ? answer({ ok: true }) : answer({ summaries: { 'proj-a': { name: 'Project A', error: null } } })
    if (url.pathname.startsWith('/ports/')) return answer({ port: 4206, isOpen: world.portIsOpen === true })
    if (url.pathname === '/tunnels') return answer({ key: body.key, label: body.label, targetUrl: body.targetUrl, status: 'preparing', text: 'Starting replayqa…', isRunning: true, projectId: null, qaUrl: null, error: null, note: null, tail: [] })
    if (url.pathname.endsWith('/stop')) return answer({})
    if (url.pathname.endsWith('/view')) return answer({})
    if (url.pathname === '/frames' && feed.length) return answer({ version: 1, frames: {}, ...feed.shift() })
    return answer({ error: 'not here' }, 500)
  })
  on('ui.toast', (_: any, e: any) => { said.push(String(e.text)); return { value: undefined } })
  on('ui.log', (_: any, e: any) => { said.push(String(e.text)); return { value: undefined } })
  on('ui.status', () => ({ value: undefined }))
  on('command.register', () => ({ value: { command: 'replayqa' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.close', () => ({ value: {} }))
  on('session.start', (_: any, e: any) => ({ cwd: e.cwd }))
  on('command.run', () => ({ text: '' }))
  on('tool.call', { tool: 'Bash' }, () => ({ result: {}, text: world.bash ?? '' }) as any)
  if (world.bashAndMcp) on('tool.call', { tool: /^mcp__/ }, () => ({ result: {}, text: '{"bugs":[]}' }) as any)

  await $.session.start({ cwd, surface: 'terminal', isInteractive: true })
  await clock.settle()

  const mount = (surface: 'terminal' | 'desktop' | 'vscode' | 'mobile' = 'terminal') => $.ui.mount({
    plugin: 'replay-qa', component: 'Pane', requestId: 'replay-qa-canvas', surface,
    props: { title: 'Replay QA', isFocused: true, bodyColumns: 80, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} },
  })
  const run = async (args: string) => {
    const answered = await $.command.run({ command: 'replayqa', args })
    await clock.settle()
    return String(answered.text ?? '')
  }
  const called = (path: string) => relay.filter(call => call.path === path)
  const followed = () => called('/qa/follow').filter(call => call.body.on !== false).map(call => call.body.projectId)
  /** Hands the plugin a frame feed answer, as the relay's long poll would. */
  const pushFeed = async (answer: Record<string, unknown>) => {
    feed.push(answer)
    await clock.advance(1100)
    await clock.settle()
  }
  return { clock, mount, run, relay, runs, written, said, minted, mcpCalls, called, followed, files, store, pushFeed }
}

// ------------------------------------------------------- another folder's project

test('a folder with no config never opens a project seen somewhere else', async ($, on) => {
  const { run, followed, mount, called, store } = await session($, on, {
    store: { 'qa-last-project': STALE_PROJECT, 'qa-last-project:/work/other': 'proj-other' },
  })
  const text = await run('')
  expect(followed()).toEqual([])
  expect(text.includes(STALE_PROJECT)).toBe(false)
  expect(text.includes('proj-other')).toBe(false)
  expect(text).toContain('No Replay QA project in ui yet')
  expect(called('/qa/folder')[0]?.body.view).toBe('setup')
  const ui = await mount()
  expect(await ui.find({ type: 'Text', text: /has no Replay QA project yet/ })).toBeTruthy()
  await ui.unmount()
  // The old key is gone, not carried over: it cannot say which folder it belonged to.
  expect(store.has('qa-last-project')).toBe(false)
})

test('canvas with no argument behaves the same, and follow and unfollow do not reach for another project', async ($, on) => {
  const { run, followed } = await session($, on, { store: { 'qa-last-project': STALE_PROJECT } })
  expect(await run('canvas')).toContain('No Replay QA project in ui yet')
  expect(await run('follow')).toContain('no Replay QA project')
  expect(await run('unfollow')).toContain('no Replay QA project')
  expect(followed()).toEqual([])
})

test('an explicit project or dashboard URL still wins, and is remembered for this folder alone', async ($, on) => {
  const { run, mount, followed, called, store } = await session($, on, { detect: { ...WORKSPACE, apps: [] } })
  await run(`canvas ${PREVIEW}/projects/proj-explicit/bugs`)
  expect(followed()).toEqual(['proj-explicit'])
  expect(called('/qa/follow')[0]?.body.server).toBe(`${PREVIEW}/projects/proj-explicit/bugs`)
  expect(store.get('qa-last-project:/work/ui')).toBe('proj-explicit')
  // Back with no argument, here, the last one seen in this folder is the fallback, and the pane says that is why.
  expect(await run('')).toContain('This is the last project used in this folder')
  expect(followed()).toEqual(['proj-explicit', 'proj-explicit'])
  const ui = await mount()
  expect(await ui.find({ type: 'Text', text: /last project used in this folder: no \.replay\/config\.json names one\. \/replayqa setup/ })).toBeTruthy()
  await ui.unmount()
})

test('a project id alone means its canvas', async ($, on) => {
  const { run, followed } = await session($, on)
  expect(await run('proj-direct')).toContain('Replay QA dashboard for Name of proj-direct')
  expect(followed()).toEqual(['proj-direct'])
})

test('a remembered project stays with its folder: a session elsewhere does not see it', async ($, on) => {
  const { run, followed } = await session($, on, {
    cwd: '/work/orly', git: { top: '/work/orly', prefix: '' }, store: { 'qa-last-project:/work/ui': 'proj-ui' },
    detect: { ...WORKSPACE, name: 'orly', root: '/work/orly', apps: [] },
  })
  expect(await run('')).toContain('No Replay QA project in orly')
  expect(followed()).toEqual([])
})

test('a row\'s Open dashboard opens that row\'s project, not the last one seen', async ($, on) => {
  const { followed, relay } = await session($, on, {
    store: { 'qa-last-project': STALE_PROJECT }, bash: JSON.stringify({ id: 'bug-1', project_id: 'proj-row', journey_id: 'j1' }),
  })
  await $.tool.call({ tool: 'Bash', command: 'npx --yes replayqa@0.7.0 mark-bug bug-1 fixed', tool_use_id: 'toolu_row' })
  expect(followed()).toEqual(['proj-row'])
  const ui = await $.ui.mount({
    plugin: 'replay-qa', component: 'ToolUse', requestId: 'toolu_row', surface: 'terminal',
    props: { tool: 'Bash', input: { command: 'npx --yes replayqa@0.7.0 mark-bug bug-1 fixed' }, isErrored: false, onScreen: { first: 0, last: 5, of: 6 } } as any,
  })
  relay.length = 0
  await ui.press({ key: 'canvas' })
  expect(followed()).toEqual(['proj-row'])
  await ui.unmount()
})

// ------------------------------------------------------------- one, several, none

test('one project opens its canvas, on the server its config names', async ($, on) => {
  const { run, called } = await session($, on, { detect: configured({ project_id: 'proj-one', path: '.', qa_url: PREVIEW }) })
  expect(await run('')).toContain('Replay QA dashboard for Name of proj-one')
  expect(called('/qa/follow').map(call => [call.body.projectId, call.body.server])).toEqual([['proj-one', PREVIEW]])
  expect(called('/canvas/proj-one/view').at(-1)?.body.on).toBe(true)
})

test('a project a config names needs no explaining', async ($, on) => {
  const { run, mount } = await session($, on, { detect: configured({ project_id: 'proj-one', path: '.', qa_url: null }) })
  expect((await run('')).includes('last project used')).toBe(false)
  const ui = await mount()
  expect(await ui.find({ type: 'Text', text: /last project used/ })).toBeFalsy()
  await ui.unmount()
})

test('several projects draw an index, on every surface; choosing one opens its canvas and Projects comes back', async ($, on) => {
  const { run, mount, called, followed } = await session($, on, {
    detect: configured({ project_id: 'proj-a', path: 'apps/a', qa_url: null }, { project_id: 'proj-b', path: 'apps/b', qa_url: PREVIEW }),
  })
  const text = await run('')
  expect(text).toContain('2 Replay QA projects in ui')
  expect(text).toContain('proj-b (apps/b)')
  expect(followed()).toEqual([])
  expect(called('/qa/folder').find(call => call.body?.view)?.body.view).toBe('index')
  for (const surface of ['terminal', 'desktop', 'vscode', 'mobile'] as const) {
    const ui = await mount(surface)
    expect((await ui.find({ key: 'open:proj-b' }))?.text).toContain('apps/b')
    expect(await ui.find({ key: 'open' })).toBeTruthy()
    await ui.unmount()
  }
  const ui = await mount()
  await ui.press({ key: 'open:proj-b' })
  expect(called('/qa/follow').map(call => [call.body.projectId, call.body.server])).toEqual([['proj-b', PREVIEW]])
  expect(await ui.find({ key: 'open' })).toBeTruthy()
  await ui.press({ key: 'projects' })
  expect(await ui.find({ key: 'open:proj-a' })).toBeTruthy()
  expect(called('/canvas/proj-b/view').at(-1)?.body.on).toBe(false)
  await ui.unmount()
})

test('none: the setup list names each app and its command, on every surface, with the two other ways in', async ($, on) => {
  const { run, mount } = await session($, on)
  const text = await run('')
  expect(text).toContain('@x/docs (apps/docs)')
  for (const surface of ['terminal', 'desktop', 'vscode', 'mobile'] as const) {
    const ui = await mount(surface)
    expect(await ui.find({ type: 'Text', text: /@x\/docs/ })).toBeTruthy()
    expect(await ui.find({ type: 'Text', text: /nx inferred from @nx\/vite\/plugin/ })).toBeTruthy()
    expect(await ui.find({ type: 'Text', text: /port 4206 \(vite\.config\.mts\)/ })).toBeTruthy()
    expect(await ui.find({ type: 'Text', text: /\$ cd apps\/docs && npx --yes replayqa@0\.7\.0 run/ })).toBeTruthy()
    expect(await ui.find({ key: 'start:/work/ui/apps/docs' })).toBeTruthy()
    expect(await ui.find({ type: 'Text', text: /suggestions/ })).toBeTruthy()
    expect(await ui.find({ type: 'Text', text: /Use an existing project/ })).toBeTruthy()
    expect(await ui.find({ type: 'Text', text: /Test a public URL/ })).toBeTruthy()
    if (surface === 'mobile') expect(await ui.find({ type: 'Text', text: /\/replayqa use/ })).toBeTruthy()
    else expect(await ui.find({ key: 'use' })).toBeTruthy()
    await ui.unmount()
  }
})

test('nothing found is said plainly, with the two other ways in still offered', async ($, on) => {
  const { run, mount } = await session($, on, { detect: { ...WORKSPACE, mode: 'none', workspace: { tools: [], package_manager: null }, apps: [], libraries: 0 } })
  expect(await run('')).toContain('nothing here looks like an app to start')
  const ui = await mount()
  expect(await ui.find({ type: 'Text', text: /Nothing was found here to test/ })).toBeTruthy()
  expect(await ui.find({ key: 'use' })).toBeTruthy()
  expect(await ui.find({ key: 'test' })).toBeTruthy()
  await ui.unmount()
})

test('setup lists apps even where a project is configured', async ($, on) => {
  const { run, runs, mount } = await session($, on, { detect: { ...WORKSPACE, projects: [{ project_id: 'proj-web', path: 'apps/web', qa_url: null }] } })
  expect(await run('setup')).toContain('@x/docs (apps/docs)')
  expect(runs.find(call => call.argv.includes('detect'))?.argv).toEqual(['npx', '--yes', 'replayqa@0.7.0', 'detect', '--apps', '--json'])
  const ui = await mount()
  expect(await ui.find({ key: 'start:/work/ui/apps/docs' })).toBeTruthy()
  await ui.unmount()
})

// ------------------------------------------------------------- without detection

const UNPUBLISHED = 'npm error code ETARGET\nnpm error notarget No matching version found for replayqa@0.7.0.\nnpm error notarget In most cases you or one of your dependencies are requesting\n'

test('with no detection the nearest config stands in, and the pane says why', async ($, on) => {
  const { run, mount, followed, called, store } = await session($, on, {
    cwd: '/work/mono/apps/docs/src', git: { top: '/work/mono', prefix: 'apps/docs/src/' }, detect: { failWith: UNPUBLISHED },
    files: {
      '/work/mono/.replay/config.json': JSON.stringify({ 'qa-project-id': 'proj-root' }),
      '/work/mono/apps/docs/.replay/config.json': JSON.stringify({ 'qa-project-id': 'proj-docs', proxy: { 'qa-url': PREVIEW } }),
      '/work/.replay/config.json': JSON.stringify({ 'qa-project-id': 'proj-above-the-repo' }),
    },
  })
  const text = await run('')
  expect(followed()).toEqual(['proj-docs'])
  expect(called('/qa/follow')[0]?.body.server).toBe(PREVIEW)
  expect(text).toContain("Detection isn't available yet: replayqa@0.7.0 isn't published.")
  const ui = await mount()
  expect(await ui.find({ type: 'Text', text: /Detection isn't available yet: replayqa@0\.7\.0 isn't published/ })).toBeTruthy()
  await ui.unmount()
  expect(store.get('qa-last-project:/work/mono/apps/docs')).toBe('proj-docs')
})

test('with no detection and no config the pane says so, and still offers the other ways in', async ($, on) => {
  const { run, mount, followed } = await session($, on, { detect: { failWith: UNPUBLISHED }, store: { 'qa-last-project': STALE_PROJECT } })
  expect(await run('')).toContain("Detection isn't available yet")
  expect(followed()).toEqual([])
  const ui = await mount()
  expect(await ui.find({ type: 'Text', text: /Detection isn't available yet: replayqa@0\.7\.0 isn't published/ })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /No \.replay\/config\.json names a project/ })).toBeTruthy()
  expect(await ui.find({ key: 'use' })).toBeTruthy()
  await ui.unmount()
})

test('why detection did not run is told apart: offline, and anything else', async ($, on) => {
  const offline = await session($, on, { detect: { failWith: 'npm error code ENOTFOUND\nnpm error network request failed' } })
  expect(await offline.run('')).toContain('npm could not be reached')
})

test('a CLI that prints nonsense is no detection either', async ($, on) => {
  const { run } = await session($, on, { detect: 'not json' as unknown })
  expect(await run('')).toContain('did not print what was expected')
})

test('a config above the session in another package does not count outside git', async ($, on) => {
  const { run, followed } = await session($, on, {
    cwd: '/work/plain/sub', git: null, detect: { failWith: UNPUBLISHED },
    files: { '/work/plain/.replay/config.json': JSON.stringify({ 'qa-project-id': 'proj-above' }) },
  })
  await run('')
  expect(followed()).toEqual([])
})

test('REPLAY_QA_CLI runs a checkout of the CLI instead of the pinned one', async ($, on) => {
  const { run, runs } = await session($, on, { env: { REPLAY_QA_CLI: 'node /src/replayqa-cli/bin.js' } })
  await run('')
  expect(runs.find(call => call.argv.includes('detect'))?.argv).toEqual(['node', '/src/replayqa-cli/bin.js', 'detect', '--json'])
})

// ------------------------------------------------------------------ starting one

test('Start asks first, then has the relay run the app and its tunnel, with no call to the MCP server from a press', async ($, on) => {
  const { run, mount, called, mcpCalls, said } = await session($, on)
  const answer = await run('')
  const ui = await mount()
  await ui.press({ key: 'start:/work/ui/apps/docs' })
  expect(called('/tunnels')).toEqual([])
  expect(await ui.find({ type: 'Text', text: /creates a Replay QA project in apps\/docs\/\.replay\/config\.json/ })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /uses QA credits/ })).toBeTruthy()
  await ui.press({ key: 'cancel:/work/ui/apps/docs' })
  expect(called('/tunnels')).toEqual([])
  await ui.press({ key: 'start:/work/ui/apps/docs' })
  const before = mcpCalls.length
  await ui.press({ key: 'confirm:/work/ui/apps/docs' })
  // From a press the engine would stop to ask about the tool: the relay mints, on its own sign-in.
  expect(mcpCalls.length).toBe(before)
  const [start] = called('/tunnels')
  expect(start?.body.cwd).toBe('/work/ui/apps/docs')
  expect(start?.body.args).toEqual(['run', 'http://localhost:4206', '--app-command', 'cd ../.. && pnpm nx dev @x/docs', '--create-project', '--name', '@x/docs'])
  expect('credential' in start!.body).toBe(false)
  expect(start?.headers['x-replay-qa-hook-token']).toBe('hook-secret')
  expect(await ui.find({ key: 'stop:/work/ui/apps/docs' })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /Starting replayqa/ })).toBeTruthy()
  // No credential where a person or a log would read it.
  for (const text of [answer, ...said]) expect(text.includes('mcl_')).toBe(false)
  await ui.press({ key: 'stop:/work/ui/apps/docs' })
  expect(called('/tunnels/%2Fwork%2Fui%2Fapps%2Fdocs/stop').length).toBe(1)
  await ui.unmount()
})

test('a port already taken is said, and what runs there can be used instead', async ($, on) => {
  const { run, mount, called } = await session($, on, { portIsOpen: true })
  await run('')
  const ui = await mount()
  await ui.press({ key: 'start:/work/ui/apps/docs' })
  expect(await ui.find({ type: 'Text', text: /already listening on port 4206/ })).toBeTruthy()
  await ui.press({ key: 'attach:/work/ui/apps/docs' })
  expect(called('/tunnels')[0]?.body.args).toEqual(['run', 'http://localhost:4206', '--create-project', '--name', '@x/docs', '--no-app'])
  await ui.unmount()
})

// Production, until loop-qa #6641 ships create_cli_credential: connected, signed in through /mcp or not, and no such tool.
const NO_SIGN_IN = /live views and tunnels have no sign-in\. Run npx --yes replayqa@0\.7\.0 login/
const SIGN_IN_AGAIN = 'MCP server "plugin:replay-qa:replay-qa" needs you to sign in again (run /mcp to re-authenticate)'

test('with no such tool and no other sign-in, nobody is told to do what would not help, on any surface', async ($, on) => {
  const { run, mount, called, said, mcpCalls } = await session($, on, { mcp: 'no-tool' })
  const text = await run('')
  expect(text).toContain('@x/docs (apps/docs)')
  expect(mcpCalls.length).toBeGreaterThan(0)
  for (const surface of ['terminal', 'desktop', 'vscode', 'mobile'] as const) {
    const ui = await mount(surface)
    expect(await ui.find({ type: 'Text', text: NO_SIGN_IN })).toBeTruthy()
    expect(await ui.find({ type: 'Text', text: /\/mcp/ })).toBeFalsy()
    // The rest of the list stands.
    expect(await ui.find({ key: 'start:/work/ui/apps/docs' })).toBeTruthy()
    await ui.unmount()
  }
  expect(called('/auth/credential')).toEqual([])
  // What the server answered stays out of the log, the toasts and the transcript.
  expect(said.filter(line => /no connected MCP tool|create_cli_credential/.test(line))).toEqual([])
  expect(/no connected MCP tool|create_cli_credential/.test(text)).toBe(false)
  expect(called('/qa/folder').find(call => call.body?.signIn)?.body.signIn).toMatch(NO_SIGN_IN)
})

test('with no such tool, Start still runs, on whatever sign-in the CLI finds', async ($, on) => {
  const { run, mount, called } = await session($, on, { mcp: 'no-tool' })
  await run('')
  const ui = await mount()
  await ui.press({ key: 'start:/work/ui/apps/docs' })
  await ui.press({ key: 'confirm:/work/ui/apps/docs' })
  const [start] = called('/tunnels')
  expect(start?.body.args[0]).toBe('run')
  expect('credential' in start!.body).toBe(false)
  expect(await ui.find({ key: 'stop:/work/ui/apps/docs' })).toBeTruthy()
  await ui.unmount()
})

test('with no such tool, one project still opens its canvas and several still draw the index', async ($, on) => {
  const one = await session($, on, { mcp: 'no-tool', detect: configured({ project_id: 'proj-one', path: '.', qa_url: null }) })
  expect(await one.run('')).toContain('Replay QA dashboard for Name of proj-one')
  expect(one.followed()).toEqual(['proj-one'])
  const ui = await one.mount()
  expect(await ui.find({ key: 'open' })).toBeTruthy()
  await ui.unmount()
})

test('with no such tool, the index is drawn too', async ($, on) => {
  const { run, mount } = await session($, on, { mcp: 'no-tool', detect: configured({ project_id: 'proj-a', path: 'apps/a', qa_url: null }, { project_id: 'proj-b', path: 'apps/b', qa_url: null }) })
  expect(await run('')).toContain('2 Replay QA projects')
  const ui = await mount()
  expect(await ui.find({ key: 'open:proj-b' })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: NO_SIGN_IN })).toBeTruthy()
  await ui.unmount()
})

test('with no such tool, an existing sign-in is simply used, with no talk of /mcp', async ($, on) => {
  const { run, mount, called } = await session($, on, { mcp: 'no-tool', existing: true })
  await run('')
  const ui = await mount()
  expect((await ui.find({ type: 'Text', text: /Using your existing Replay sign-in/ }))?.text).toBe('Using your existing Replay sign-in.')
  expect(await ui.find({ type: 'Text', text: /\/mcp/ })).toBeFalsy()
  await ui.press({ key: 'start:/work/ui/apps/docs' })
  await ui.press({ key: 'confirm:/work/ui/apps/docs' })
  expect('credential' in called('/tunnels')[0]!.body).toBe(false)
  await ui.unmount()
})

test('a sign-in is asked for only when the server asks for one', async ($, on) => {
  const { run, mount } = await session($, on, { mcp: 'needs-auth' })
  await run('')
  const ui = await mount()
  expect(await ui.find({ type: 'Text', text: /Not signed in: run \/mcp and sign in to replay-qa, or run npx --yes replayqa@0\.7\.0 login/ })).toBeTruthy()
  await ui.unmount()
})

test('a server that lists its tools to anyone and answers 401 to the call also asks for one', async ($, on) => {
  const { run, mount, said } = await session($, on, { mcp: 'needs-auth-at-call' })
  await run('')
  const ui = await mount()
  expect(await ui.find({ type: 'Text', text: /Not signed in: run \/mcp/ })).toBeTruthy()
  await ui.unmount()
  expect(said.filter(line => line.includes(SIGN_IN_AGAIN))).toEqual([])
})

test('a sign-in the server cannot share (an API token) is not told to sign in again', async ($, on) => {
  const { run, mount } = await session($, on, { mcp: 'cannot-share' })
  await run('')
  const ui = await mount()
  expect(await ui.find({ type: 'Text', text: NO_SIGN_IN })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /\/mcp/ })).toBeFalsy()
  await ui.unmount()
})

test('an MCP server that never answers holds nothing up', async ($, on) => {
  const { run, mount, clock, called } = await session($, on, { mcp: 'hangs' })
  let answered = ''
  void run('').then(text => { answered = text })
  await clock.settle()
  await clock.advance(9_000)
  await clock.settle()
  expect(answered).toContain('@x/docs (apps/docs)')
  const ui = await mount()
  await ui.press({ key: 'start:/work/ui/apps/docs' })
  await ui.press({ key: 'confirm:/work/ui/apps/docs' })
  expect(called('/tunnels').length).toBe(1)
  await ui.unmount()
})

test('the model asking for a credential itself is not waved through: only the plugin\'s own call is', async ($, on) => {
  await session($, on, { mcpVerdict: 'ask' })
  const asked = await $.tool.check({ tool: 'mcp__plugin_replay-qa_replay-qa__create_cli_credential', input: {} })
  expect(asked.decision).toBe('ask')
})

test('the tools the server does have go through untouched', async ($, on) => {
  const { said, followed } = await session($, on, { mcp: 'no-tool', existing: true, bashAndMcp: true })
  const answer = await $.tool.call({ tool: 'mcp__plugin_replay-qa_replay-qa__list_bugs', project_id: 'proj-a' } as any)
  expect(answer.deny).toBeUndefined()
  expect(answer.text).toBe('{"bugs":[]}')
  expect(followed()).toEqual([])
  expect(said).toEqual([])
})

test('a start that failed says why, with the app\'s last words, and can be tried again', async ($, on) => {
  const failed = { key: '/work/ui/apps/docs', label: '@x/docs', targetUrl: 'http://localhost:4206', status: 'failed', text: 'It stopped with an error.', isRunning: false, projectId: null, qaUrl: null, error: 'A managed process exited before http://localhost:4206 became ready.', note: null, tail: ['Starting local app: pnpm nx dev', 'ERR_PNPM_RECURSIVE_EXEC_FIRST_FAIL Command "nx" not found', 'Error: A managed process exited before http://localhost:4206 became ready.'] }
  const { run, mount, pushFeed } = await session($, on)
  await run('')
  await pushFeed({ tunnels: [failed] })
  const ui = await mount()
  expect(await ui.find({ type: 'Text', text: /⚠ A managed process exited before/ })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /Command "nx" not found/ })).toBeTruthy()
  expect((await ui.find({ key: 'start:/work/ui/apps/docs' }))?.props.label).toBe('Start again')
  await ui.unmount()
})

test('/replayqa start and stop work without the pane', async ($, on) => {
  const { run, called } = await session($, on)
  expect(await run('start apps/docs')).toContain('Starting @x/docs on http://localhost:4206')
  expect(called('/tunnels')[0]?.body.cwd).toBe('/work/ui/apps/docs')
  expect(await run('start nope')).toContain("Name one of this folder's apps: apps/docs")
  expect(await run('stop nope')).toContain('Name one of these: @x/docs')
  expect(await run('stop apps/docs')).toContain('Stopping @x/docs')
})

test('a tunnel that made its project opens that canvas and says so', async ($, on) => {
  const tunnel = { key: '/work/ui/apps/docs', label: '@x/docs', targetUrl: 'http://localhost:4206', status: 'connecting', text: 'Connecting the tunnel…', isRunning: true, projectId: 'proj-made', qaUrl: 'https://qa.replay.io', error: null, note: null, tail: [] }
  const { run, mount, followed, pushFeed, said } = await session($, on)
  await run('')
  await pushFeed({ tunnels: [tunnel] })
  expect(followed()).toContain('proj-made')
  expect(said.some(text => text.includes('proj-made'))).toBe(true)
  const ui = await mount()
  expect(await ui.find({ key: 'open' })).toBeTruthy()
  expect(await ui.find({ key: 'stopTunnel' })).toBeTruthy()
  await ui.unmount()
})

test('a press in the browser view is acted on, once checked against the folder', async ($, on) => {
  const { run, called, pushFeed } = await session($, on)
  await run('')
  await pushFeed({ actions: [{ type: 'start', key: '/somewhere/else' }, { type: 'start', key: '/work/ui/apps/docs' }, { type: 'stop', key: 'not-a-tunnel' }, { type: 'nonsense' }] })
  expect(called('/tunnels').map(call => call.body.cwd)).toEqual(['/work/ui/apps/docs'])
  expect(called('/tunnels/not-a-tunnel/stop')).toEqual([])
})

// ------------------------------------------------------- the other two ways in

test('use: links through the CLI, then opens the canvas', async ($, on) => {
  const { run, runs, followed, written } = await session($, on)
  expect(await run('use proj-mine')).toContain('now uses Replay QA project proj-mine')
  expect(runs.find(call => call.argv.includes('link'))?.argv).toEqual(['npx', '--yes', 'replayqa@0.7.0', 'link', 'proj-mine'])
  expect(written).toEqual({})
  expect(followed()).toEqual(['proj-mine'])
})

test('use from the field, with a dashboard URL on another server', async ($, on) => {
  const { run, mount, runs, called } = await session($, on)
  await run('')
  const ui = await mount()
  await ui.input({ key: 'use', text: `${PREVIEW}/projects/proj-url/bugs` })
  expect(runs.find(call => call.argv.includes('link'))?.argv.at(-1)).toBe(`${PREVIEW}/projects/proj-url/bugs`)
  expect(called('/qa/follow')[0]?.body.projectId).toBe('proj-url')
  await ui.unmount()
})

test('use: before the CLI is published the id is written to the nearest config, keeping what is there', async ($, on) => {
  const { run, written } = await session($, on, {
    cwd: '/work/mono/apps/docs', git: { top: '/work/mono', prefix: 'apps/docs/' }, link: { exitCode: 1, stderr: UNPUBLISHED },
    files: { '/work/mono/apps/docs/package.json': '{}' },
  })
  await run('use proj-here')
  expect(JSON.parse(written['/work/mono/apps/docs/.replay/config.json']!)).toEqual({ 'qa-project-id': 'proj-here' })
})

test('use: what the CLI refuses is said, with no stack trace', async ($, on) => {
  const stderr = 'Error: .replay/config.json already contains qa-project-id proj-old; not overwriting it with proj-new.\n    at writeConfigProjectId (/x.js:1:1)\n'
  const { run, mount, written, followed } = await session($, on, { link: { exitCode: 1, stderr } })
  expect(await run('use proj-new')).toBe('Replay QA: .replay/config.json already contains qa-project-id proj-old; not overwriting it with proj-new.')
  expect(written).toEqual({})
  expect(followed()).toEqual([])
  await run('')
  const ui = await mount()
  await ui.input({ key: 'use', text: 'proj-new' })
  expect(await ui.find({ type: 'Text', text: /already contains qa-project-id proj-old/ })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /writeConfigProjectId/ })).toBeFalsy()
  await ui.unmount()
})

test('use: nonsense is refused before anything runs', async ($, on) => {
  const { run, runs } = await session($, on)
  expect(await run('use banana')).toContain('is not a Replay QA project id')
  expect(runs.some(call => call.argv.includes('link'))).toBe(false)
})

test('test: a public URL is set up on a credential of its own, in the environment, and its canvas opens', async ($, on) => {
  const stdout = '=== Replay QA project ===\n{\n  "project_id": "proj-public",\n  "source": "created"\n}\n'
  const { run, runs, followed, said } = await session($, on, { bootstrap: { exitCode: 0, stdout } })
  const answer = await run('test https://example.com/app')
  const [boot] = runs.filter(call => call.argv.includes('bootstrap'))
  expect(boot?.argv).toEqual(['npx', '--yes', 'replayqa@0.7.0', 'bootstrap', 'https://example.com/app', '--public'])
  expect(boot?.init.env.REPLAY_QA_API_KEY).toBe(`${CREDENTIAL}relay`)
  expect(boot?.init.cwd).toBe('/work/ui')
  expect(followed()).toEqual(['proj-public'])
  for (const text of [answer, ...said]) expect(text.includes('mcl_')).toBe(false)
})

test('test: what the CLI says when it made no project reaches the person', async ($, on) => {
  const { run } = await session($, on, { bootstrap: { exitCode: 1, stderr: 'Error: Replay QA authentication is required.\n    at x (/y.js:1:1)' } })
  expect(await run('test https://example.com')).toBe('Replay QA: Replay QA authentication is required.')
})

test('test: before the CLI is published it says so', async ($, on) => {
  const { run } = await session($, on, { bootstrap: { exitCode: 1, stderr: UNPUBLISHED } })
  expect(await run('test https://example.com')).toContain("replayqa@0.7.0 isn't published yet")
})

test('test: a project it made is opened even if what it asked next failed', async ($, on) => {
  const { run, followed } = await session($, on, { bootstrap: { exitCode: 1, stdout: '=== Replay QA project ===\n{ "project_id": "proj-made" }\n', stderr: 'Error: Replay QA request failed (500)' } })
  await run('test https://example.com')
  expect(followed()).toEqual(['proj-made'])
})

test('test: a local address or a non-address is refused with what to do instead', async ($, on) => {
  const { run, runs } = await session($, on)
  expect(await run('test http://localhost:3000')).toContain("can't reach it without a tunnel")
  expect(await run('test example.com')).toContain('is not a full URL')
  expect(runs.some(call => call.argv.includes('bootstrap'))).toBe(false)
})

// ---------------------------------------------------------------------- the relay

test('nothing but a hook asks the MCP server: not a press, not the browser view, not the background', { timeoutMs: 20_000 }, async ($, on) => {
  const { run, mount, mcpCalls, clock, pushFeed, called } = await session($, on, { mcp: 'no-tool', detect: { ...WORKSPACE } })
  await run('')
  const after = mcpCalls.length
  expect(after).toBeGreaterThan(0)
  const ui = await mount()
  await ui.press({ key: 'start:/work/ui/apps/docs' })
  await ui.press({ key: 'confirm:/work/ui/apps/docs' })
  await ui.unmount()
  await pushFeed({ actions: [{ type: 'test', value: 'https://example.com' }] })
  await clock.advance(20 * 60_000)
  await clock.settle()
  expect(mcpCalls.length).toBe(after)
  expect(called('/tunnels').length).toBe(1)
})

test('a later command tries again: the person may just have signed in', async ($, on) => {
  const { run, mcpCalls } = await session($, on, { mcp: 'needs-auth' })
  await run('')
  const first = mcpCalls.length
  await run('')
  expect(mcpCalls.length).toBeGreaterThan(first)
})

test('the relay gets the MCP sign-in once, and no credential is said anywhere', async ($, on) => {
  const { run, called, said } = await session($, on, { detect: configured({ project_id: 'proj-one', path: '.', qa_url: null }) })
  const answer = await run('')
  expect(called('/auth/credential').length).toBe(1)
  expect(called('/auth/credential')[0]?.body.credential.startsWith('mcl_')).toBe(true)
  await run('')
  expect(called('/auth/credential').length).toBe(1)
  for (const text of [answer, ...said]) expect(text.includes('mcl_')).toBe(false)
  for (const call of called('/qa/follow')) expect(JSON.stringify(call.body).includes('mcl_')).toBe(false)
})

// ----------------------------------------------------------------------- errors

test('the canvas says which server failed, whole and in a row of its own', async ($, on) => {
  const error = `Replay QA on ${new URL(PREVIEW).host} answered 500 for project ${STALE_PROJECT}. That server is the preview of PR #7162, which may have been merged or closed.`
  const { run, mount } = await session($, on, {
    detect: configured({ project_id: STALE_PROJECT, path: '.', qa_url: null }),
    overview: projectId => overviewOf(projectId, error, `${PREVIEW}/api/v1`),
  })
  await run('')
  const ui = await mount()
  const row = await ui.find({ type: 'Text', text: /answered 500/ })
  expect(row?.text).toContain('pr-7162--loop-qa-j63k5x.netlify.app')
  expect(row?.text).toContain('preview of PR #7162')
  expect(await ui.find({ type: 'Text', text: /pr-7162--loop-qa-j63k5x\.netlify\.app$/ })).toBeTruthy()
  await ui.unmount()
})
