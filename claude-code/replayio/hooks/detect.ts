// Recognizes the Bash commands that open or close a Replay / playwright-cli
// browser session, and the session names their output reports.

export type BrowserCommand = {
  kind: 'open' | 'close'
  /** The session named on the command line; null when absent or a shell variable. */
  session: string | null
  /**
   * The directory the command ran in: playwright-cli keeps a session per
   * directory, so the tracer must be injected from there. The base directory
   * moved by any `cd` earlier in the command; null when a `cd` could not be
   * followed (`~`, a variable) or no base was given.
   */
  cwd: string | null
}

const CLI = /(^|[\s/"'])(playwright-cli|pwcli)(\.sh)?["']?$|\$\{?PWCLI\}?["']?$|playwright_cli\.sh["']?$/i
const OPEN_SCRIPT = /browser-open\.js["']?$/
const CLOSE_SCRIPT = /browser-close\.js["']?$/

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

function sessionFlag(argv: string[]): string | null {
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] ?? ''
    const eq = /^(?:-s|--session)=(.*)$/.exec(arg)
    if (eq) return literal(eq[1])
    if (arg === '-s' || arg === '--session') return literal(argv[i + 1])
  }
  return null
}

/** The flag-free verb after the CLI word: `open`, `close`, `snapshot`... */
function verb(argv: string[]): string | null {
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] ?? ''
    if (arg === '-s' || arg === '--session') {
      i++
      continue
    }
    if (arg.startsWith('-')) continue
    return arg
  }
  return null
}

/** `dir` moved by `target`, as `cd` would, without the filesystem; null when it cannot be known. */
export function joinDir(dir: string | null, target: string): string | null {
  if (target.includes('$') || target.includes('`') || target.startsWith('~') || target === '-') return null
  const parts = target.startsWith('/') ? [] : (dir ?? '').split('/').filter(Boolean)
  if (!target.startsWith('/') && dir === null) return null
  for (const part of target.split('/')) {
    if (part === '' || part === '.') continue
    if (part === '..') parts.pop()
    else parts.push(part)
  }
  return `/${parts.join('/')}`
}

export function parseBrowserCommands(command: string, baseCwd: string | null = null): BrowserCommand[] {
  const found: BrowserCommand[] = []
  let cwd = baseCwd
  for (const segment of command.split(/&&|\|\||[;\n|]/)) {
    const argv = words(segment.trim())
    // `cd dir`, possibly after VAR=value prefixes: later segments run there.
    const cdAt = argv.findIndex(w => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(w))
    if (argv[cdAt] === 'cd') {
      cwd = argv[cdAt + 1] === undefined ? cwd : joinDir(cwd, argv[cdAt + 1]!)
      continue
    }
    const at = argv.findIndex(w => CLI.test(w) || OPEN_SCRIPT.test(w) || CLOSE_SCRIPT.test(w))
    if (at < 0) continue
    const tool = argv[at] ?? ''
    const rest = argv.slice(at + 1)
    if (OPEN_SCRIPT.test(tool)) found.push({ kind: 'open', session: sessionFlag(rest), cwd })
    else if (CLOSE_SCRIPT.test(tool)) found.push({ kind: 'close', session: sessionFlag(rest), cwd })
    else {
      const v = verb(rest)
      if (v === 'open' || v === 'close') found.push({ kind: v, session: sessionFlag(rest), cwd })
    }
  }
  return found
}

/** Sessions an output says were opened: playwright-cli's line, browser-open.js's JSON. */
export function openedSessions(output: string): string[] {
  const names = new Set<string>()
  for (const m of output.matchAll(/Browser [`'"]([^`'"\s]+)[`'"] opened/g)) if (m[1]) names.add(m[1])
  for (const m of output.matchAll(/"playwright_session"\s*:\s*"([^"]+)"/g)) if (m[1]) names.add(m[1])
  return [...names]
}

/** Sessions an output says were closed. */
export function closedSessions(output: string): string[] {
  const names = new Set<string>()
  for (const m of output.matchAll(/Browser [`'"]([^`'"\s]+)[`'"] closed/g)) if (m[1]) names.add(m[1])
  return [...names]
}
