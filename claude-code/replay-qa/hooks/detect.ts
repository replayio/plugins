// Recognizes the Replay QA scripts a Bash command runs, and reads what they (or the QA MCP
// tools) printed: the project, a newly started exploration, bug and run ids.
//
// The scripts print pretty JSON through `qa.printJson` (a response object) or `printSection`
// (`=== Title ===` followed by JSON), so output is read by finding JSON values in the text,
// with a regex fallback on the ids, which are recognizable by prefix (`proj-`, `expl-`, `run-`,
// `bug-`).

export type QaScript =
  | 'start-exploration'
  | 'rerun-journeys'
  | 'mark-bug'
  | 'report-missing-bug'
  | 'full-qa'
  | 'status'
  | 'bootstrap'

const SCRIPTS: QaScript[] = ['start-exploration', 'rerun-journeys', 'mark-bug', 'report-missing-bug', 'full-qa', 'status', 'bootstrap']
const SCRIPT_WORD = new RegExp(`(?:^|/)(${SCRIPTS.join('|')})\\.js["']?$`)
const RUNNERS = new Set(['node', 'bun', 'deno', 'tsx', 'nodejs'])
const PROJECT_ID = /proj-[A-Za-z0-9_-]+/

export type QaCommand = {
  script: QaScript
  projectId?: string
  bugId?: string
  bugStatus?: string
  /** The backend will start a test run of its own because of this command (a bug marked fixed, a missing bug reported). */
  startsRun: boolean
  /** The QA server the script talks to when it is not the default: REPLAY_QA_API_BASE or REPLAY_QA_URL set on the command. */
  server?: string
}

/** Shell words of one simple command, quotes removed (no expansion). */
function words(segment: string): string[] {
  const out: string[] = []
  const re = /"((?:\\.|[^"\\])*)"|'([^']*)'|(\S+)/g
  for (let m = re.exec(segment); m; m = re.exec(segment)) out.push(m[1] ?? m[2] ?? m[3] ?? '')
  return out
}

const SEGMENTS = /&&|\|\||[;\n|]/
const VALUE_FLAGS = new Set([
  '--project-id', '--project', '--project-url', '--bug-id', '--status', '--prompt', '--title', '--description', '--name',
  '--target-url', '--instructions', '--journey-id', '--page', '--page-size', '--interval-ms',
])

/** Names a segment assigns: `SCRIPT=".../start-exploration.js"` and `FOO=bar node x.js`. */
function assignments(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {}
  for (const w of argv) {
    const m = /^(?:export\s+)?([A-Za-z_]\w*)=(.*)$/.exec(w)
    if (m) out[m[1]!] = m[2]!.replace(/["']/g, '')
  }
  return out
}

/** The Replay QA script a command runs, with the arguments that matter; null when it runs none. */
export function parseQaCommand(command: string): QaCommand | null {
  const env: Record<string, string> = {}
  for (const segment of command.split(SEGMENTS)) {
    const argv = words(segment.trim())
    Object.assign(env, assignments(argv))
    for (let i = 0; i < argv.length; i++) {
      const raw = argv[i]!
      if (/^(?:export\s+)?[A-Za-z_]\w*=/.test(raw)) continue
      // `node "$SCRIPT"` where an earlier assignment named the file.
      const variable = /^\$\{?([A-Za-z_]\w*)\}?$/.exec(raw)?.[1]
      const word = variable ? (env[variable] ?? '') : raw
      const script = SCRIPT_WORD.exec(word)?.[1] as QaScript | undefined
      if (!script) continue
      // It runs only when something executes it: a runner before it, or the word is the command.
      const before = argv.slice(0, i).filter(w => !/^[A-Za-z_]\w*=/.test(w) && w !== 'export')
      const runs = before.length === 0 || before.some(w => RUNNERS.has(w.split('/').pop()!))
      if (!runs) continue
      return fromArgs(script, argv.slice(i + 1), env)
    }
  }
  return null
}

function fromArgs(script: QaScript, args: string[], env: Record<string, string>): QaCommand {
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
  const bugId = flags['--bug-id'] ?? (script === 'mark-bug' ? positional.find(p => !PROJECT_ID.test(p)) : undefined)
  const bugStatus = script === 'mark-bug'
    ? flags['--status'] ?? positional.filter(p => p !== bugId && !PROJECT_ID.test(p))[0] ?? 'fixed'
    : undefined
  const startsRun =
    (script === 'mark-bug' && bugStatus === 'fixed')
    || (script === 'rerun-journeys' && Boolean(bugId))
    || script === 'report-missing-bug'
  const server = env.REPLAY_QA_API_BASE || env.REPLAY_QA_URL
  return { script, ...(projectId ? { projectId } : {}), ...(bugId ? { bugId } : {}), ...(bugStatus ? { bugStatus } : {}), startsRun, ...(server ? { server } : {}) }
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
