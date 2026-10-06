// The card every Replay MCP tool result is drawn as, and the markdown helpers
// the per-tool parsers build cards with. Parsers are pure: (input, text) -> Card,
// so they are tested against recorded tool outputs without a terminal.
//
// Anatomy (replay-mcpui PRD, component contract): a header (tool, one-line
// summary, status and scope badges), 1-3 key facts, one primary evidence
// preview, collapsible sections (consumed data, related events, raw payload)
// and footer actions (open in Replay, ask Claude for the next step, copy).

export type Tone = 'accent' | 'good' | 'bad' | 'warn' | 'info' | 'muted'

export type Status = 'complete' | 'partial' | 'empty' | 'error' | 'running'

export type Scope =
  | 'recording-wide'
  | 'point-scoped'
  | 'source-scoped'
  | 'component-scoped'
  | 'request-scoped'
  | 'profile-scoped'

export type Fact = { label: string; value: string; tone?: Tone }

export type CodeLine = { n?: number; hits?: string; text: string; isMarked?: boolean; isUnhit?: boolean }

export type Block =
  | { kind: 'text'; text: string; tone?: Tone }
  | { kind: 'markdown'; text: string }
  | { kind: 'facts'; items: Fact[] }
  | { kind: 'list'; items: { text: string; detail?: string; tone?: Tone; badge?: string }[] }
  | { kind: 'table'; columns: string[]; rows: string[][]; numeric?: boolean[]; tones?: (Tone | undefined)[] }
  | { kind: 'code'; path?: string; lines: CodeLine[] }
  | { kind: 'bars'; items: { label: string; value: number; display: string; tone?: Tone }[] }
  | { kind: 'tree'; lines: { depth: number; text: string; detail?: string; isOpen?: boolean }[] }
  | { kind: 'image'; url: string; caption?: string }

export type Section = { id: string; title: string; blocks: Block[] }

export type Action =
  | { kind: 'prompt'; label: string; text: string }
  | { kind: 'url'; label: string; url: string }
  | { kind: 'copy'; label: string; text: string }

export type Card = {
  tool: string
  title: string
  summary: string
  status: Status
  scope: Scope
  facts: Fact[]
  preview: Block[]
  sections: Section[]
  actions: Action[]
}

export type ToolInput = Record<string, unknown> & { recordingId?: string }

export type CardParser = (input: ToolInput, text: string) => Card

// ------------------------------------------------------------------ markdown

/** `**bold**`, `` `code` ``, `_em_` and link syntax removed. */
export function plain(text: string): string {
  return text
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/(^|\s)_([^_]+)_(?=\s|$)/g, '$1$2')
    .trim()
}

export type MdSection = { level: number; title: string; body: string }

/** Splits on `#` headings; text before the first heading is a level-0 section. */
export function sections(text: string): MdSection[] {
  const out: MdSection[] = [{ level: 0, title: '', body: '' }]
  let fence = false
  for (const line of text.split('\n')) {
    if (/^```/.test(line)) fence = !fence
    const m = !fence && /^(#{1,6})\s+(.*)$/.exec(line)
    if (m) out.push({ level: m[1]!.length, title: plain(m[2]!), body: '' })
    else out[out.length - 1]!.body += `${line}\n`
  }
  return out.filter(s => s.title || s.body.trim())
}

/** The first section whose title matches. */
export function section(text: string, title: RegExp): string | undefined {
  return sections(text).find(s => title.test(s.title))?.body
}

/** `**Key:** value` and `- **Key:** value` lines, in order. */
export function boldFacts(text: string): Fact[] {
  const facts: Fact[] = []
  for (const line of text.split('\n')) {
    const m = /^\s*(?:[-*•]\s+)?\*\*([^*]+?):?\*\*:?\s*(.+)$/.exec(line)
    if (m) facts.push({ label: m[1]!.replace(/:$/, '').trim(), value: plain(m[2]!) })
  }
  return facts
}

/** `Key: value` lines (no bold), as plain-text tools print them. */
export function colonFacts(text: string, keys?: RegExp): Fact[] {
  const facts: Fact[] = []
  for (const line of text.split('\n')) {
    const m = /^\s*([A-Z][A-Za-z ()/-]{1,40}):\s+(.+)$/.exec(line)
    if (m && (!keys || keys.test(m[1]!))) facts.push({ label: m[1]!.trim(), value: plain(m[2]!) })
  }
  return facts
}

export function fact(facts: Fact[], label: RegExp): string | undefined {
  return facts.find(f => label.test(f.label))?.value
}

export type MdTable = { columns: string[]; rows: string[][] }

/** Every pipe table in the text. */
export function tables(text: string): MdTable[] {
  const out: MdTable[] = []
  const lines = text.split('\n')
  for (let i = 0; i < lines.length - 1; i++) {
    const head = lines[i]!
    const rule = lines[i + 1]!
    // A header row, then a separator such as `|---|:--:|`, `------|------` or
    // `| : | -----: |`: only pipes, colons, dashes and spaces, with a dash somewhere.
    if (!head.includes('|') || !rule.includes('-') || !/^[\s|:-]+$/.test(rule)) continue
    const cells = (line: string) => line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map(c => plain(c.trim()))
    const columns = cells(head)
    const rows: string[][] = []
    let j = i + 2
    for (; j < lines.length && lines[j]!.includes('|') && lines[j]!.trim() !== ''; j++) rows.push(cells(lines[j]!))
    out.push({ columns, rows })
    i = j - 1
  }
  return out
}

/** `- item`, `• item`, `* item` and `1. item` lines. */
export function bullets(text: string): string[] {
  return text
    .split('\n')
    .map(l => /^\s*(?:[-*•]|\d+\.)\s+(.*)$/.exec(l)?.[1])
    .filter((l): l is string => Boolean(l))
    .map(plain)
}

/** The "Next Steps" / "Suggested Next Steps" bullets. */
export function nextSteps(text: string): string[] {
  const body = section(text, /next steps/i)
  if (!body) return []
  const lines: string[] = []
  for (const raw of body.split('\n')) {
    const m = /^\s*(?:[-*•]|\d+\.)\s+(.*)$/.exec(raw)
    if (m) lines.push(plain(m[1]!))
    else if (raw.trim() && lines.length) lines[lines.length - 1] += ` — ${plain(raw.trim())}`
  }
  return lines
}

export function points(text: string): string[] {
  return [...new Set(text.match(/Point:\d+/g) ?? [])]
}

export const num = (s: string | undefined): number => {
  const m = /-?[\d,]*\.?\d+/.exec(s ?? '')
  return m ? Number(m[0].replace(/,/g, '')) : NaN
}

export function ms(value: number): string {
  if (!Number.isFinite(value)) return '?'
  if (value >= 60_000) return `${Math.floor(value / 60_000)}m ${Math.round((value % 60_000) / 1000)}s`
  if (value >= 1000) return `${(value / 1000).toFixed(value >= 10_000 ? 0 : 1)}s`
  return `${Math.round(value)}ms`
}

export const truncate = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s)

// ------------------------------------------------------------------- shared

export const recordingUrl = (input: ToolInput) =>
  input.recordingId ? `https://app.replay.io/recording/${input.recordingId}` : undefined

/** Footer actions every card has: the Replay link, the next steps as prompts, and a copy of the output. */
export function baseActions(input: ToolInput, text: string, extra: Action[] = []): Action[] {
  const actions: Action[] = [...extra]
  const url = recordingUrl(input)
  if (url && !actions.some(a => a.kind === 'url')) actions.push({ kind: 'url', label: 'Open in Replay', url })
  // A card with its own next action leaves out the generic "Next steps" prompts it would repeat.
  for (const step of extra.some(a => a.kind === 'prompt') ? [] : nextSteps(text).slice(0, 2)) {
    actions.push({ kind: 'prompt', label: `Next: ${truncate(step.replace(/^Use\s+/i, ''), 34)}`, text: `${step}${input.recordingId ? ` (recording ${input.recordingId})` : ''}` })
  }
  actions.push({ kind: 'copy', label: 'Copy output', text })
  return actions
}

export function rawSection(text: string): Section {
  const limit = 6000
  return { id: 'raw', title: 'Raw output', blocks: [{ kind: 'markdown', text: text.length > limit ? `${text.slice(0, limit)}\n\n… ${text.length - limit} more characters` : text }] }
}

/** A card for an error the tool reported, or a recording that lacks what it inspects. */
export function errorCard(tool: string, input: ToolInput, text: string, scope: Scope = 'recording-wide'): Card {
  const message = plain(text.replace(/^\[[A-Za-z]+\]\s*/, '')) || 'The tool returned an error.'
  const isNotFound = /not found in this recording|requires a recording/i.test(text)
  const isDenied = /access denied|permission/i.test(text)
  return {
    tool,
    title: tool,
    summary: isNotFound ? 'Not used in this recording' : isDenied ? 'No access to this recording' : 'The tool reported an error',
    status: isNotFound ? 'empty' : 'error',
    scope,
    facts: [],
    preview: [{ kind: 'text', text: message, tone: isNotFound ? 'muted' : 'bad' }],
    sections: [],
    actions: isDenied
      ? [{ kind: 'prompt', label: 'Sign in to Replay', text: 'The Replay MCP tool says access was denied. Start `replayio login` in the background and wait for me to confirm I have signed in.' }]
      : baseActions(input, text),
  }
}

/** The fallback card: headline facts, the first section as the preview, the rest collapsed. */
export function genericCard(tool: string, input: ToolInput, text: string, scope: Scope = 'recording-wide'): Card {
  const parts = sections(text).filter(s => !/next steps/i.test(s.title))
  const facts = boldFacts(text).slice(0, 3)
  const first = parts[0]
  const firstTable = first ? tables(first.body)[0] : undefined
  const preview: Block[] = first
    ? firstTable
      ? [{ kind: 'table', columns: firstTable.columns, rows: firstTable.rows.slice(0, 8) }]
      : [{ kind: 'markdown', text: truncate(first.body.trim(), 900) }]
    : []
  return {
    tool,
    title: tool,
    summary: first?.title || truncate(plain(text.split('\n').find(l => l.trim()) ?? ''), 80),
    status: text.trim() ? 'complete' : 'empty',
    scope,
    facts,
    preview,
    sections: [
      ...parts.slice(1, 6).map((s, i) => ({ id: `s${i}`, title: s.title || 'Details', blocks: [{ kind: 'markdown' as const, text: truncate(s.body.trim(), 3000) }] })),
      rawSection(text),
    ],
    actions: baseActions(input, text),
  }
}
