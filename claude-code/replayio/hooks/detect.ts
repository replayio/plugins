// Recognizes the Bash commands that open or close a browser session the live
// players should follow, and the session names their output reports.
//
// Agents run these in many shapes: `playwright-cli …`, `npx -y @playwright/cli …`,
// `"$PWCLI" …`, a wrapper such as `pw(){ npx -y @playwright/cli "$@"; }` then
// `pw open …`, `agent-browser …`, with `cd`, `export` and pipes around them. The
// command text is parsed for what it can tell, and the CLI's own output
// (`Browser `x` opened`) covers the rest.

export type BrowserTool = 'playwright-cli' | 'agent-browser'

export type BrowserCommand = {
  tool: BrowserTool
  kind: 'open' | 'close'
  /** The session named by a flag or environment variable; null when it is not given or is a shell variable. */
  session: string | null
  /**
   * The directory the command ran in: playwright-cli keeps a session per
   * directory, so the tracer must be injected from there. The base directory
   * moved by any `cd` earlier in the command; null when a `cd` could not be
   * followed (`~`, a variable) or no base was given.
   */
  cwd: string | null
  /** `close --all`: every session. */
  all?: true
}

const PLAYWRIGHT = /(^|[\s/"'])(playwright-cli|pwcli)(\.sh)?["']?$|@playwright\/cli["']?$|\$\{?PWCLI\}?["']?$|playwright_cli\.sh["']?$/i
const AGENT = /(^|[\s/"'])agent-browser["']?$/
const OPEN_SCRIPT = /browser-open\.js["']?$/
const CLOSE_SCRIPT = /browser-close\.js["']?$/

/** agent-browser flags that take a value, so the value is not mistaken for the verb. */
const AGENT_VALUE_FLAGS = new Set([
  '--session', '--executable-path', '--init-script', '--enable', '--args', '--profile', '--session-name', '--state',
  '--headers', '--extension', '--user-agent', '--proxy', '--proxy-bypass', '--cdp', '--color-scheme', '--download-path',
  '--provider', '-p', '--device', '--engine', '--model', '--config', '--screenshot-dir', '--screenshot-quality',
  '--screenshot-format', '--max-output', '--allowed-domains', '--action-policy', '--confirm-actions',
])
const PLAYWRIGHT_VALUE_FLAGS = new Set(['-s', '--session', '--browser', '--config', '--profile'])

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
function verb(argv: string[], valueFlags: Set<string>): string | null {
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] ?? ''
    if (valueFlags.has(arg)) {
      i++
      continue
    }
    if (arg.startsWith('-') || arg.startsWith('>') || /^\d?>/.test(arg)) continue
    return arg
  }
  return null
}

/** Names the command defines as wrappers of a CLI: `pw(){ … @playwright/cli … }`, `alias`, `P="npx -y @playwright/cli"`. */
function aliases(command: string): { playwright: Set<string>; agent: Set<string> } {
  const playwright = new Set<string>()
  const agent = new Set<string>()
  const add = (name: string, body: string) => {
    if (/playwright-cli|@playwright\/cli|pwcli/.test(body)) {
      playwright.add(name)
      playwright.add(`$${name}`)
      playwright.add(`\${${name}}`)
    } else if (/agent-browser/.test(body)) {
      agent.add(name)
      agent.add(`$${name}`)
      agent.add(`\${${name}}`)
    }
  }
  for (const m of command.matchAll(/([A-Za-z_][\w-]*)\s*\(\)\s*\{([^}]*)\}/g)) add(m[1]!, m[2]!)
  for (const m of command.matchAll(/\balias\s+([\w-]+)=(["'])(.*?)\2/g)) add(m[1]!, m[3]!)
  for (const m of command.matchAll(/(?:^|[\s;&|])([A-Za-z_]\w*)=(["'])([^"']*)\2/g)) add(m[1]!, m[3]!)
  return { playwright, agent }
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

const SEGMENTS = /&&|\|\||[;\n|]/

/** The directory a command leaves the shell in: `baseCwd` moved by every `cd` in it. */
export function endCwd(command: string, baseCwd: string | null): string | null {
  let cwd = baseCwd
  for (const segment of command.split(SEGMENTS)) {
    const argv = words(segment.trim())
    const at = argv.findIndex(w => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(w))
    if (argv[at] === 'cd' && argv[at + 1] !== undefined) cwd = joinDir(cwd, argv[at + 1]!)
  }
  return cwd
}

export function parseBrowserCommands(command: string, baseCwd: string | null = null): BrowserCommand[] {
  const found: BrowserCommand[] = []
  const alias = aliases(command)
  const env: Record<string, string> = {}
  let cwd = baseCwd
  for (const segment of command.split(SEGMENTS)) {
    const argv = words(segment.trim())
    for (const w of argv) {
      const m = /^(?:export\s+)?([A-Za-z_]\w*)=(.*)$/.exec(w)
      if (m) env[m[1]!] = m[2]!.replace(/["']/g, '')
    }
    // `cd dir`, possibly after VAR=value prefixes: later segments run there.
    const cdAt = argv.findIndex(w => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(w) && w !== 'export')
    if (argv[cdAt] === 'cd') {
      cwd = argv[cdAt + 1] === undefined ? cwd : joinDir(cwd, argv[cdAt + 1]!)
      continue
    }
    const toolOf = (w: string): BrowserTool | 'open-script' | 'close-script' | null =>
      OPEN_SCRIPT.test(w) ? 'open-script'
        : CLOSE_SCRIPT.test(w) ? 'close-script'
          : PLAYWRIGHT.test(w) || alias.playwright.has(w) ? 'playwright-cli'
            : AGENT.test(w) || alias.agent.has(w) ? 'agent-browser'
              : null
    let at = argv.findIndex(w => toolOf(w) !== null)
    if (at < 0) continue
    const kindOfTool = toolOf(argv[at]!)!
    // `npx --package @playwright/cli playwright-cli …`: the real command is the last of the run.
    while (argv[at + 1] !== undefined && toolOf(argv[at + 1]!) === kindOfTool) at++
    const rest = argv.slice(at + 1)
    if (kindOfTool === 'open-script') found.push({ tool: 'playwright-cli', kind: 'open', session: sessionFlag(rest), cwd })
    else if (kindOfTool === 'close-script') found.push({ tool: 'playwright-cli', kind: 'close', session: sessionFlag(rest), cwd })
    else if (kindOfTool === 'agent-browser') {
      const v = verb(rest, AGENT_VALUE_FLAGS)
      if (v === 'open' || v === 'close') {
        const session = sessionFlag(rest) ?? literal(env.AGENT_BROWSER_SESSION) ?? 'default'
        found.push({ tool: 'agent-browser', kind: v, session, cwd, ...(v === 'close' && rest.includes('--all') ? { all: true as const } : {}) })
      }
    } else {
      const v = verb(rest, PLAYWRIGHT_VALUE_FLAGS)
      if (v === 'open' || v === 'close') {
        found.push({ tool: 'playwright-cli', kind: v, session: sessionFlag(rest) ?? literal(env.PLAYWRIGHT_CLI_SESSION), cwd })
      }
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

/**
 * The commands the text showed, plus any open or close only the output reveals
 * (a wrapper function, an alias, a variable holding the CLI), closes first.
 */
export function withOutput(commands: BrowserCommand[], output: string, cwd: string | null): BrowserCommand[] {
  const out = [...commands]
  if (!commands.some(c => c.kind === 'open')) {
    for (const session of openedSessions(output)) out.push({ tool: 'playwright-cli', kind: 'open', session, cwd })
  }
  if (!commands.some(c => c.kind === 'close')) {
    for (const session of closedSessions(output).reverse()) out.unshift({ tool: 'playwright-cli', kind: 'close', session, cwd })
  }
  return out
}
