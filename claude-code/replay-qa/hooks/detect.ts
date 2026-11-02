// Recognizes the `replayqa` commands a Bash command runs, and reads what they (or the QA MCP
// tools) printed: the project, a newly started exploration, bug and run ids.
//
// The CLI prints pretty JSON (a response object) or `=== Title ===` sections followed by JSON,
// so output is read by finding JSON values in the text, with a regex fallback on the ids, which
// are recognizable by prefix (`proj-`, `expl-`, `run-`, `bug-`).

export type QaVerb =
  | 'start-exploration'
  | 'rerun-journeys'
  | 'mark-bug'
  | 'report-missing-bug'
  | 'full-qa'
  | 'status'
  | 'bootstrap'

const VERBS = new Set<string>(['start-exploration', 'rerun-journeys', 'mark-bug', 'report-missing-bug', 'full-qa', 'status', 'bootstrap'])
const CLI = /^(?:.*\/)?replayqa(?:@[\w.-]+)?$/
/** What runs a package by name; `pnpm dlx replayqa`, `npm exec replayqa` and `yarn dlx replayqa` have a word more. */
const RUNNERS = new Set(['npx', 'bunx', 'pnpx', 'pnpm', 'npm', 'yarn', 'exec', 'command', 'env', 'time', 'nohup', 'sudo'])
const SHELL_WORDS = new Set(['then', 'do', 'else', 'if', 'while', 'until', '!', '{', '('])
const PROJECT_ID = /proj-[A-Za-z0-9_-]+/

export type QaCommand = {
  verb: QaVerb
  projectId?: string
  bugId?: string
  bugStatus?: string
  /** The backend will start a test run of its own because of this command (a bug marked fixed, a missing bug reported). */
  startsRun: boolean
  /** The QA server the command talks to when it is not the default: REPLAY_QA_API_BASE or REPLAY_QA_URL set on it. */
  server?: string
}

/** Shell words of one simple command, quotes removed (no expansion). */
function words(segment: string): string[] {
  const out: string[] = []
  // A word can be several quoted and bare runs: `QA="npx replayqa"`, `--project="proj-a"`.
  const re = /(?:"(?:\\.|[^"\\])*"|'[^']*'|[^\s"']+)+/g
  for (const m of segment.matchAll(re)) out.push(m[0].replace(/"((?:\\.|[^"\\])*)"|'([^']*)'/g, (_, a, b) => a ?? b ?? ''))
  return out
}

const SEGMENTS = /&&|\|\||[;\n|]/
const VALUE_FLAGS = new Set([
  '--project-id', '--project', '--project-url', '--bug-id', '--status', '--prompt', '--title', '--description', '--name',
  '--target-url', '--instructions', '--journey-id', '--page', '--page-size', '--interval-ms',
])

/** Names a segment assigns: `QA="npx --yes replayqa@x.y.z"` and `FOO=bar replayqa status`. */
function assignments(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {}
  for (const w of argv) {
    const m = /^([A-Za-z_]\w*)=(.*)$/.exec(w)
    if (m) out[m[1]!] = m[2]!
  }
  return out
}

/** Shell functions wrapping the CLI: `qa(){ npx --yes replayqa@x.y.z "$@"; }`. */
function wrappers(command: string): Set<string> {
  const names = new Set<string>()
  for (const m of command.matchAll(/([A-Za-z_][\w-]*)\s*\(\)\s*\{([^}]*)\}/g)) if (/\breplayqa\b/.test(m[2]!)) names.add(m[1]!)
  return names
}

/** The `replayqa` verb a command runs, with the arguments that matter; null when it runs no verb the live views follow. */
export function parseQaCommand(command: string): QaCommand | null {
  const env: Record<string, string> = {}
  const wrapped = wrappers(command)
  for (const segment of command.split(SEGMENTS)) {
    const argv = words(segment.trim())
    Object.assign(env, assignments(argv))
    // The CLI must be what runs, not a word it is given: `grep replayqa README.md` is a grep.
    let at = 0
    while (at < argv.length && (/^[A-Za-z_]\w*=/.test(argv[at]!) || argv[at] === 'export' || SHELL_WORDS.has(argv[at]!))) at++
    if (argv[at] === undefined) continue
    // `$QA status`, where an earlier assignment named the command.
    const variable = /^\$\{?([A-Za-z_]\w*)\}?$/.exec(argv[at]!)?.[1]
    const line = variable ? [...words(env[variable] ?? ''), ...argv.slice(at + 1)] : argv.slice(at)
    const head = line[0]?.replace(/^(?:\$\(|\()+/, '') ?? ''
    let cli = -1
    if (CLI.test(head)) cli = 0
    else if (wrapped.has(head)) cli = 0
    else if (RUNNERS.has(head.split('/').pop()!)) cli = line.findIndex((w, i) => i > 0 && CLI.test(w))
    if (cli < 0) continue
    // `npx --package replayqa replayqa status`: the real command is the last of the run.
    while (line[cli + 1] !== undefined && CLI.test(line[cli + 1]!)) cli++
    const verb = line[cli + 1]
    if (verb === undefined || !VERBS.has(verb)) continue
    return fromArgs(verb as QaVerb, line.slice(cli + 2), env)
  }
  return null
}

function fromArgs(verb: QaVerb, args: string[], env: Record<string, string>): QaCommand {
  const flags: Record<string, string> = {}
  const positional: string[] = []
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!
    if (arg === '--') { positional.push(...args.slice(i + 1)); break }
    const eq = /^(--[\w-]+)=(.*)$/.exec(arg)
    if (eq) { flags[eq[1]!] = eq[2]!; continue }
    if (VALUE_FLAGS.has(arg) && args[i + 1] !== undefined) { flags[arg] = args[++i]!; continue }
    if (arg.startsWith('--')) continue
    positional.push(arg)
  }
  const projectId =
    PROJECT_ID.exec(flags['--project-id'] ?? flags['--project'] ?? flags['--project-url'] ?? '')?.[0]
    ?? positional.map(p => PROJECT_ID.exec(p)?.[0]).find(Boolean)
    ?? PROJECT_ID.exec(env.REPLAY_QA_PROJECT_ID ?? '')?.[0]
  const bugId = flags['--bug-id'] ?? (verb === 'mark-bug' ? positional.find(p => !PROJECT_ID.test(p)) : undefined)
  const bugStatus = verb === 'mark-bug'
    ? flags['--status'] ?? positional.filter(p => p !== bugId && !PROJECT_ID.test(p))[0] ?? 'fixed'
    : undefined
  const startsRun =
    (verb === 'mark-bug' && bugStatus === 'fixed')
    || (verb === 'rerun-journeys' && Boolean(bugId))
    || verb === 'report-missing-bug'
  const server = env.REPLAY_QA_API_BASE || env.REPLAY_QA_URL
  return { verb, ...(projectId ? { projectId } : {}), ...(bugId ? { bugId } : {}), ...(bugStatus ? { bugStatus } : {}), startsRun, ...(server ? { server } : {}) }
}

// ------------------------------------------------------------------- output

export type QaOutput = {
  projectId?: string
  /** An exploration the output is about: its top-level object (one just started), not one listed in a status. */
  explorationId?: string
  explorationStatus?: string
  prompt?: string
  runIds: string[]
  bugId?: string
  /** The journey a bug record belongs to: the one the backend re-tests when the bug is marked fixed. */
  journeyId?: string
  /** Every exploration id mentioned anywhere, for callers that want to match one. */
  seenExplorationIds: string[]
  /** The QA server named by a reverse-proxy runbook's `replayqa proxy … --qa-url <url>`. */
  qaUrl?: string
}

/** JSON values in a text: the whole text if it is JSON, else each `{`/`[` line start that parses. */
export function jsonValues(text: string): unknown[] {
  const trimmed = text.trim()
  try {
    return [JSON.parse(trimmed)]
  } catch {}
  const out: unknown[] = []
  const lines = text.split('\n')
  let offset = 0
  // Where the last value ended: lines inside it are part of it, not values of their own.
  let consumed = -1
  for (const line of lines) {
    const start = offset + (line.length - line.trimStart().length)
    offset += line.length + 1
    const ch = line.trimStart()[0]
    if (start <= consumed || (ch !== '{' && ch !== '[')) continue
    const end = matching(text, start)
    if (end < 0) continue
    try {
      out.push(JSON.parse(text.slice(start, end + 1)))
      consumed = end
    } catch {}
    if (out.length >= 20) break
  }
  return out
}

/** Index of the bracket closing the one at `start`, aware of strings; -1 when unbalanced. */
function matching(text: string, start: number): number {
  let depth = 0
  let inString = false
  for (let i = start; i < text.length; i++) {
    const c = text[i]!
    if (inString) {
      if (c === '\\') i++
      else if (c === '"') inString = false
      continue
    }
    if (c === '"') inString = true
    else if (c === '{' || c === '[') depth++
    else if (c === '}' || c === ']') {
      depth--
      if (depth === 0) return i
    }
  }
  return -1
}

export function parseQaOutput(text: string): QaOutput {
  const out: QaOutput = { runIds: [], seenExplorationIds: [] }
  const add = (list: string[], id: string) => { if (!list.includes(id)) list.push(id) }
  const values = jsonValues(text)

  const walk = (value: unknown, top: boolean, depth: number) => {
    if (!value || typeof value !== 'object' || depth > 8) return
    if (Array.isArray(value)) { for (const v of value) walk(v, false, depth + 1); return }
    const o = value as Record<string, unknown>
    const id = typeof o.id === 'string' ? o.id : ''
    if (/^proj-/.test(id)) out.projectId ??= id
    if (typeof o.project_id === 'string' && /^proj-/.test(o.project_id)) out.projectId ??= o.project_id
    if (/^expl-/.test(id)) {
      add(out.seenExplorationIds, id)
      if (top && !out.explorationId) {
        out.explorationId = id
        if (typeof o.status === 'string') out.explorationStatus = o.status
        if (typeof o.prompt === 'string') out.prompt = o.prompt
      }
    }
    if (typeof o.exploration_id === 'string' && /^expl-/.test(o.exploration_id)) add(out.seenExplorationIds, o.exploration_id)
    if (/^run-/.test(id) && out.runIds.length < 20) add(out.runIds, id)
    if (typeof o.test_run_id === 'string' && /^run-/.test(o.test_run_id) && out.runIds.length < 20) add(out.runIds, o.test_run_id)
    if (/^bug-/.test(id)) {
      out.bugId ??= id
      if (typeof o.journey_id === 'string') out.journeyId ??= o.journey_id
    }
    if (typeof o.bug_id === 'string') out.bugId ??= o.bug_id
    for (const v of Object.values(o)) walk(v, false, depth + 1)
  }
  for (const v of values) walk(v, true, 0)

  const anyProject = out.projectId ? undefined : PROJECT_ID.exec(text)?.[0]
  if (anyProject) out.projectId = anyProject
  for (const m of text.matchAll(/\bexpl-[A-Za-z0-9_-]+/g)) add(out.seenExplorationIds, m[0])
  for (const m of text.matchAll(/\brun-[A-Za-z0-9_-]+/g)) if (out.runIds.length < 20) add(out.runIds, m[0])
  const qaUrl = /--qa-url(?:=|\s+)["']?(https?:\/\/[^\s"'\\]+)/.exec(text)?.[1]
  if (qaUrl) out.qaUrl = qaUrl
  return out
}

/** Is this status one of a running exploration or test run? */
export function isRunningStatus(status: string | undefined): boolean {
  return status === 'in-progress' || status === 'running' || status === 'pending' || status === 'queued'
}
