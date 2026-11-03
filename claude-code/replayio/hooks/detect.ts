// Recognizes the shell commands that touch an agent-browser session, so every host can record
// each one. Written here for the Claude Code mod; `npm run build` in live/ also compiles it to
// live/detect.mjs for the other hosts' hooks.
//
// Agents run these in many shapes: `agent-browser …`, `npx agent-browser …`, a wrapper such as
// `ab(){ agent-browser "$@"; }` then `ab open …`, with `cd`, `export` and pipes around them.
// agent-browser starts a browser for any command that needs one, so every such verb counts: the
// relay keeps one recording per session, and recording a session twice is a no-op.

export type BrowserCommand = {
  /** `open`: this command ran against a browser. `close`: it closed one. */
  kind: 'open' | 'close'
  /** The session it ran in: the flag, then AGENT_BROWSER_SESSION set in the command; null when it is a shell variable. */
  session: string | null
  /** The directory it ran in: the base moved by any `cd` before it; null when a `cd` could not be followed. */
  cwd: string | null
  /** `close --all`: every session. */
  all?: true
}

const AGENT = /(^|[\s/"'])agent-browser["']?$/
const OPEN_SCRIPT = /browser-open\.js["']?$/
const CLOSE_SCRIPT = /browser-close\.js["']?$/

/** Flags that take a value, so the value is not mistaken for the verb. */
const VALUE_FLAGS = new Set([
  '-s', '--session', '--executable-path', '--init-script', '--enable', '--args', '--profile', '--session-name', '--state',
  '--headers', '--extension', '--user-agent', '--proxy', '--proxy-bypass', '--cdp', '--color-scheme', '--download-path',
  '--provider', '-p', '--device', '--engine', '--model', '--config', '--screenshot-dir', '--screenshot-quality',
  '--screenshot-format', '--max-output', '--allowed-domains', '--action-policy', '--confirm-actions',
])

/** Verbs that never touch a browser: they must not make the recorder ask for one. */
const NO_BROWSER = new Set([
  'auth', 'confirm', 'dashboard', 'deny', 'doctor', 'help', 'install', 'profiles', 'session', 'skills', 'upgrade', 'version',
])

/** Shell words of one simple command, quotes removed (no expansion). */
function words(segment: string): string[] {
  const out: string[] = []
  const re = /"((?:\\.|[^"\\])*)"|'([^']*)'|(\S+)/g
  for (let m = re.exec(segment); m; m = re.exec(segment)) {
    out.push(m[1] ?? m[2] ?? m[3] ?? '')
  }
  return out
}

function literal(value: string | undefined): string | null {
  // `--session="rt"` is one word with its quotes inside.
  const unquoted = value?.replace(/["']/g, '')
  if (!unquoted || unquoted.includes('$') || unquoted.includes('`')) return null
  return unquoted
}

function sessionFlag(argv: string[]): string | undefined {
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] ?? ''
    const eq = /^(?:-s|--session)=(.*)$/.exec(arg)
    if (eq) return eq[1] ?? ''
    if (arg === '-s' || arg === '--session') return argv[i + 1] ?? ''
  }
  return undefined
}

/** The flag-free verb after the CLI word: `open`, `close`, `snapshot`... */
function verb(argv: string[]): string | null {
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] ?? ''
    if (VALUE_FLAGS.has(arg)) {
      i++
      continue
    }
    if (arg.startsWith('-') || arg.startsWith('>') || /^\d?>/.test(arg)) continue
    return arg
  }
  return null
}

/** Names the command defines as wrappers of the CLI: `ab(){ agent-browser … }`, `alias`, `AB="npx agent-browser"`. */
function aliases(command: string): Set<string> {
  const agent = new Set<string>()
  const add = (name: string, body: string) => {
    if (!/agent-browser/.test(body)) return
    agent.add(name)
    agent.add(`$${name}`)
    agent.add(`\${${name}}`)
  }
  for (const m of command.matchAll(/([A-Za-z_][\w-]*)\s*\(\)\s*\{([^}]*)\}/g)) add(m[1]!, m[2]!)
  for (const m of command.matchAll(/\balias\s+([\w-]+)=(["'])(.*?)\2/g)) add(m[1]!, m[3]!)
  for (const m of command.matchAll(/(?:^|[\s;&|])([A-Za-z_]\w*)=(["'])([^"']*)\2/g)) add(m[1]!, m[3]!)
  return agent
}

/** `dir` moved by `target`, as `cd` would, without the filesystem; null when it cannot be known. */
export function joinDir(dir: string | null, target: string): string | null {
  if (target.includes('$') || target.includes('`') || target.startsWith('~') || target === '-') return null
  if (!target.startsWith('/') && dir === null) return null
  const parts = target.startsWith('/') ? [] : (dir ?? '').split('/').filter(Boolean)
  for (const part of target.split('/')) {
    if (part === '' || part === '.') continue
    if (part === '..') parts.pop()
    else parts.push(part)
  }
  return `/${parts.join('/')}`
}

const SEGMENTS = /&&|\|\||[;\n|]/

/** Words that come before the command they run: `npx agent-browser …`, `then agent-browser …`. */
const RUNNERS = new Set(['npx', 'bunx', 'pnpx', 'pnpm', 'yarn', 'dlx', 'exec', 'command', 'env', 'time', 'nohup', 'sudo'])
const SHELL_WORDS = new Set(['then', 'do', 'else', 'if', 'while', 'until', '!', '{', '('])

/** Where the command word of a simple command is, past assignments and shell keywords. */
function commandAt(argv: string[]): number {
  let at = 0
  while (at < argv.length && (/^[A-Za-z_]\w*=/.test(argv[at]!) || argv[at] === 'export' || SHELL_WORDS.has(argv[at]!))) at++
  return at
}

export function parseBrowserCommands(command: string, baseCwd: string | null = null): BrowserCommand[] {
  const found: BrowserCommand[] = []
  const alias = aliases(command)
  const env: Record<string, string> = {}
  let cwd = baseCwd
  for (const segment of command.split(SEGMENTS)) {
    const argv = words(segment.trim())
    for (const w of argv) {
      const m = /^([A-Za-z_]\w*)=(.*)$/.exec(w)
      if (m) env[m[1]!] = m[2]!.replace(/["']/g, '')
    }
    // `cd dir`, possibly after VAR=value prefixes: later segments run there.
    const cdAt = argv.findIndex(w => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(w) && w !== 'export')
    if (argv[cdAt] === 'cd') {
      cwd = argv[cdAt + 1] === undefined ? cwd : joinDir(cwd, argv[cdAt + 1]!)
      continue
    }
    const isCli = (w: string) => AGENT.test(w) || alias.has(w)
    const scriptAt = argv.findIndex(w => OPEN_SCRIPT.test(w) || CLOSE_SCRIPT.test(w))
    if (scriptAt >= 0) {
      const flag = sessionFlag(argv.slice(scriptAt + 1))
      found.push({
        kind: OPEN_SCRIPT.test(argv[scriptAt]!) ? 'open' : 'close',
        session: flag === undefined ? null : literal(flag),
        cwd,
      })
      continue
    }
    // The CLI must be what runs, not a word it is given: `grep agent-browser README.md` is a grep.
    argv[commandAt(argv)] = (argv[commandAt(argv)] ?? '').replace(/^(?:\$\(|\()+/, '')
    let at = commandAt(argv)
    if (argv[at] !== undefined && !isCli(argv[at]!) && RUNNERS.has(argv[at]!)) {
      at = argv.findIndex((w, i) => i > at && isCli(w))
      if (at < 0) continue
    }
    if (argv[at] === undefined || !isCli(argv[at]!)) continue
    // `npx --package agent-browser agent-browser …`: the real command is the last of the run.
    while (argv[at + 1] !== undefined && isCli(argv[at + 1]!)) at++
    const rest = argv.slice(at + 1)
    const v = verb(rest)
    if (v === null || NO_BROWSER.has(v) || rest.includes('--help') || rest.includes('-h') || rest.includes('--version')) continue
    const flag = sessionFlag(rest)
    const session = flag !== undefined ? literal(flag)
      : env.AGENT_BROWSER_SESSION !== undefined ? literal(env.AGENT_BROWSER_SESSION)
      : 'default'
    if (v === 'close') found.push({ kind: 'close', session, cwd, ...(rest.includes('--all') ? { all: true as const } : {}) })
    else found.push({ kind: 'open', session, cwd })
  }
  return found
}

/** The session browser-open.js reports, for when its command did not name one. */
export function openedSession(output: string): string | null {
  return /"agent_browser_session"\s*:\s*"([^"]+)"/.exec(output)?.[1] ?? null
}

/** Each session once: what it last did within this command, and in the order last seen. */
export function netEffect(commands: BrowserCommand[]): BrowserCommand[] {
  const last = new Map<string, BrowserCommand>()
  for (const command of commands) {
    const key = command.all ? '*' : command.session ?? ''
    if (command.all) last.clear()
    last.delete(key)
    last.set(key, command)
  }
  return [...last.values()]
}
