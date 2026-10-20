import {
  baseActions,
  boldFacts,
  bullets,
  fact,
  genericCard,
  ms,
  nextSteps,
  num,
  plain,
  rawSection,
  section,
  sections,
  tables,
  truncate,
  type Action,
  type Block,
  type Card,
  type CardParser,
  type Fact,
  type Scope,
  type Section,
  type Tone,
  type ToolInput,
} from '../card.ts'

// Recording-wide cards: the overview, console, network, user events, storage,
// annotations, screenshots, Playwright steps and exceptions.

const mode = (input: ToolInput, fallback: string) => (typeof input.mode === 'string' ? input.mode : fallback)

const on = (input: ToolInput) => (input.recordingId ? ` on recording ${input.recordingId}` : '')

const prompt = (label: string, text: string): Action => ({ kind: 'prompt', label, text })

function card(tool: string, scope: Scope, input: ToolInput, text: string, parts: Partial<Card> & Pick<Card, 'summary'>, extra: Action[] = []): Card {
  return {
    tool,
    title: tool,
    status: 'complete',
    scope,
    facts: [],
    preview: [],
    ...parts,
    sections: [...(parts.sections ?? []), rawSection(text)],
    // Tool-specific actions replace the generic "Next:" prompts built from the text.
    actions: baseActions(input, text, extra).filter(a => !extra.length || !a.label.startsWith('Next:')),
  }
}

const levelTone = (level: string): Tone | undefined =>
  /error/i.test(level) ? 'bad' : /warn/i.test(level) ? 'warn' : /info/i.test(level) ? 'info' : undefined

const statusTone = (status: string): Tone | undefined => {
  const n = num(status)
  if (!Number.isFinite(n)) return /fail|error|abort/i.test(status) ? 'bad' : undefined
  return n >= 400 ? 'bad' : n >= 300 ? 'muted' : 'good'
}

// ------------------------------------------------------- RecordingOverview

/** Recording summary: environment, error/network/render counts, and the tools to try next. */
const recordingOverview: CardParser = (input, text) => {
  const facts = boldFacts(text)
  const url = fact(facts, /^URL$/)
  const duration = fact(facts, /^Duration$/)
  const errors = num(fact(facts, /^Errors$/))
  const warnings = num(fact(facts, /^Warnings$/))
  const requests = fact(facts, /^Total requests$/)
  const failed = num(fact(facts, /^Failed$/))
  const commits = fact(facts, /^Total commits$/)
  const env = section(text, /environment/i) ?? ''
  const consumed: Block[] = [{ kind: 'facts', items: facts.slice(0, 14) }]
  const shotTs = /timestamp[:\s`]+(\d+)/i.exec(section(text, /screenshot/i) ?? '')?.[1]
  const steps = nextSteps(text)
  const extra: Action[] = steps.filter(s => !(shotTs && /^Screenshot/.test(s))).slice(0, 2).map(s => {
    const tool = /^([A-Z][A-Za-z]+)/.exec(s)?.[1] ?? 'the suggested tool'
    return prompt(`Run ${tool}`, `Use the Replay MCP ${tool} tool${on(input)}: ${s}`)
  })
  return card(
    'RecordingOverview',
    'recording-wide',
    input,
    text,
    {
      summary: url ? truncate(url, 70) : truncate(plain(bullets(env)[0] ?? 'Recording summary'), 70),
      facts: [
        ...(duration ? [{ label: 'duration', value: duration }] : []),
        {
          label: 'errors / warnings',
          value: `${Number.isFinite(errors) ? errors : '?'} / ${Number.isFinite(warnings) ? warnings : '?'}`,
          tone: errors > 0 ? 'bad' : warnings > 0 ? 'warn' : 'good',
        },
        ...(requests ? [{ label: 'requests', value: `${requests}${failed > 0 ? ` (${failed} failed)` : ''}`, tone: (failed > 0 ? 'bad' : 'good') as Tone }] : []),
      ],
      preview: [
        {
          kind: 'list',
          items: [
            ...bullets(env).filter(b => !/^(URL|Duration):/.test(b)).map(b => ({ text: b })),
            ...(commits ? [{ text: `React: ${commits} commits, ${fact(facts, /render time/i) ?? '?'} render time` }] : []),
          ].slice(0, 6),
        },
      ],
      sections: [
        ...(steps.length ? [{ id: 'next', title: 'Suggested next steps', blocks: [{ kind: 'list', items: steps.map(s => ({ text: s, tone: 'accent' as Tone })) }] as Block[] }] : []),
        ...(shotTs ? [{ id: 'shot', title: 'Final screenshot', blocks: [{ kind: 'text', text: `Final state at ${ms(Number(shotTs))}. Run Screenshot with timestamp ${shotTs} to see it.` }] as Block[] }] : []),
        ...sections(text)
          .filter(s => /network|render|api/i.test(s.title))
          .map((s, i) => ({ id: `s${i}`, title: s.title, blocks: [{ kind: 'markdown', text: s.body.trim() }] as Block[] })),
        { id: 'consumed', title: 'Consumed data', blocks: consumed },
      ],
    },
    [...extra, ...(shotTs ? [prompt('Show final screenshot', `Use the Replay MCP Screenshot tool with timestamp ${shotTs}${on(input)}.`)] : [])],
  )
}

// --------------------------------------------------------- ConsoleMessages

type ConsoleRow = { level: string; point: string; text: string }

/** `[console.warning] (Point:1): "text"` lines. */
function consoleRows(text: string): ConsoleRow[] {
  const rows: ConsoleRow[] = []
  for (const line of text.split('\n')) {
    const m = /^\[([^\]]+)\]\s*\((Point:\d+)\):\s*(.*)$/.exec(line.trim())
    if (m) rows.push({ level: m[1]!.replace(/^console\./, ''), point: m[2]!, text: m[3]!.replace(/^"|"$/g, '').replace(/" "/g, ' ') })
  }
  return rows
}

const consoleList = (rows: ConsoleRow[]): Block => ({
  kind: 'list',
  items: rows.map(r => ({ badge: r.level.slice(0, 4).toUpperCase(), tone: levelTone(r.level), text: truncate(r.text, 160), detail: r.point })),
})

/** Console output: level counts, the latest problems, and drill-in to one message. */
const consoleMessages: CardParser = (input, text) => {
  const m = mode(input, 'summary')
  if (m === 'message-detail') {
    const level = /Level:\s*(.+)/.exec(text)?.[1]?.trim() ?? 'message'
    const point = /Point:\s*(Point:\d+|\S+)/.exec(text)?.[1] ?? String(input.point ?? '')
    const content = /Content:\s*\n([\s\S]*?)(?:\n\s*\n|\nStack trace:|$)/.exec(text)?.[1]?.trim().replace(/^"|"$/g, '') ?? ''
    const stack = /Stack trace:\s*\n([\s\S]*)$/.exec(text)?.[1] ?? ''
    const frames = stack.split('\n').map(l => /^\s*at\s+(\S+)\s+\((.+)\)/.exec(l)).filter((x): x is RegExpExecArray => Boolean(x))
    return card('ConsoleMessages', 'point-scoped', input, text, {
      summary: truncate(content || 'Console message', 80),
      facts: [
        { label: 'level', value: level.replace(/^console\./, ''), tone: levelTone(level) },
        { label: 'point', value: point },
        ...(frames.length ? [{ label: 'frames', value: String(frames.length) }] : []),
      ],
      preview: [
        { kind: 'text', text: content, tone: levelTone(level) },
        ...(frames.length ? [{ kind: 'list', items: frames.map(f => ({ text: f[1]!, detail: f[2]! })) } as Block] : []),
      ],
      sections: [{ id: 'consumed', title: 'Consumed data', blocks: [{ kind: 'facts', items: [{ label: 'point', value: point }, { label: 'source', value: /Source:\s*(.+)/.exec(text)?.[1] ?? '?' }] }] }],
    }, point ? [
      prompt('Describe this point', `Use the Replay MCP DescribePoint tool with point ${point}${on(input)}.`),
      prompt('Get the stack', `Use the Replay MCP GetStack tool with point ${point}${on(input)}.`),
    ] : [])
  }
  const rows = consoleRows(text)
  if (!rows.length && !/Summary|console messages/i.test(text)) return genericCard('ConsoleMessages', input, text)
  const total = num(/(\d+)\s+(?:total\s+)?(?:console\s+)?messages/i.exec(text)?.[0])
  const breakdown = /Breakdown:\s*(.+)/.exec(text)?.[1] ?? ''
  // The summary's "Breakdown: 12 warnings, 9 info"; otherwise count the rows shown.
  const count = (word: RegExp, level: RegExp) => {
    const m = word.exec(breakdown)
    return m ? Number(m[1]) : rows.filter(r => level.test(r.level)).length
  }
  const errors = count(/(\d+)\s+errors?/, /error/)
  const warnings = count(/(\d+)\s+warnings?/, /warn/)
  const firstError = rows.find(r => /error/.test(r.level)) ?? rows.find(r => /warn/.test(r.level))
  return card('ConsoleMessages', 'recording-wide', input, text, {
    summary: m === 'messages' ? `${Number.isFinite(total) ? total : rows.length} messages${input.level && input.level !== 'all' ? ` (${String(input.level)})` : ''}` : breakdown || 'Console summary',
    status: Number.isFinite(total) && total === 0 && !rows.length ? 'empty' : 'complete',
    facts: [
      ...(Number.isFinite(total) ? [{ label: 'messages', value: String(total) }] : []),
      { label: 'errors', value: String(errors), tone: errors > 0 ? 'bad' : 'good' },
      { label: 'warnings', value: String(warnings), tone: warnings > 0 ? 'warn' : undefined },
    ] as Fact[],
    preview: rows.length ? [consoleList(rows.slice(0, 8))] : [{ kind: 'text', text: 'No console messages.', tone: 'muted' }],
    sections: [
      ...(rows.length > 8 ? [{ id: 'all', title: `All ${rows.length} shown messages`, blocks: [consoleList(rows)] }] : []),
      { id: 'consumed', title: 'Consumed data', blocks: [{ kind: 'facts', items: [{ label: 'mode', value: m }, { label: 'points', value: truncate(rows.map(r => r.point).join(', '), 200) || 'none' }] }] },
    ],
  }, firstError ? [prompt(`Inspect ${firstError.point}`, `Use the Replay MCP ConsoleMessages tool with mode 'message-detail' and point ${firstError.point}${on(input)}.`)] : [])
}

// ---------------------------------------------------------- NetworkRequest

/** Network: summary counts and status mix, the paged request table, or one request's detail. */
const networkRequest: CardParser = (input, text) => {
  const m = mode(input, 'summary')
  const facts = boldFacts(text)
  const [first, ...rest] = tables(text)
  if (m === 'requests' && first) {
    const ci = (re: RegExp) => first.columns.findIndex(c => re.test(c))
    const [iTime, iMethod, iUrl, iStatus, iDur, iId] = [ci(/time/i), ci(/method/i), ci(/url/i), ci(/status/i), ci(/duration/i), ci(/^id$/i)]
    const pick = (r: string[], i: number) => (i >= 0 ? r[i] ?? '' : '')
    const rows = first.rows.map(r => [pick(r, iMethod), pick(r, iStatus), pick(r, iUrl), pick(r, iDur), pick(r, iTime)])
    const bad = first.rows.filter(r => num(pick(r, iStatus)) >= 400)
    const slowest = [...first.rows].sort((a, b) => num(pick(b, iDur)) - num(pick(a, iDur)))[0]
    const shown = /Showing\s+([\d–-]+)\s+of\s+(\d+)/.exec(text)
    return card('NetworkRequest', 'recording-wide', input, text, {
      summary: shown ? `Requests ${shown[1]} of ${shown[2]}` : `${first.rows.length} requests`,
      facts: [
        { label: 'shown', value: String(first.rows.length) },
        { label: 'failed', value: String(bad.length), tone: bad.length ? 'bad' : 'good' },
        ...(slowest ? [{ label: 'slowest', value: `${pick(slowest, iDur)} ${truncate(pick(slowest, iUrl), 30)}` }] : []),
      ],
      preview: [{ kind: 'table', columns: ['Method', 'Status', 'URL', 'Duration', 'Time'], rows: rows.slice(0, 10), numeric: [false, false, false, true, true], tones: first.rows.slice(0, 10).map(r => statusTone(pick(r, iStatus))) }],
      sections: [
        ...(rows.length > 10 ? [{ id: 'all', title: `All ${rows.length} rows`, blocks: [{ kind: 'table', columns: ['Method', 'Status', 'URL', 'Duration', 'Time'], rows, numeric: [false, false, false, true, true], tones: first.rows.map(r => statusTone(pick(r, iStatus))) }] as Block[] }] : []),
        { id: 'consumed', title: 'Consumed data', blocks: [{ kind: 'facts', items: [{ label: 'request ids', value: truncate(first.rows.map(r => pick(r, iId)).join(', '), 200) }] }] },
      ],
    }, [
      bad[0]
        ? prompt('Inspect failed request', `Use the Replay MCP NetworkRequest tool with mode 'detail' and requestId ${pick(bad[0], iId)}${on(input)}.`)
        : slowest ? prompt('Inspect slowest request', `Use the Replay MCP NetworkRequest tool with mode 'detail' and requestId ${pick(slowest, iId)}${on(input)}.`) : prompt('Next page', `Use the Replay MCP NetworkRequest tool with mode 'requests' and offset ${first.rows.length}${on(input)}.`),
    ])
  }
  if (m === 'summary' && facts.length) {
    const total = fact(facts, /total requests/i)
    const failed = num(fact(facts, /failed/i))
    const slow = num(fact(facts, /slow/i))
    const status = tables(section(text, /status/i) ?? '')[0]
    const types = tables(section(text, /request types/i) ?? '')[0]
    const domains = tables(section(text, /domains/i) ?? '')[0]
    const toBars = (t: typeof status, toneFor?: (k: string) => Tone | undefined): Block | undefined =>
      t && { kind: 'bars', items: t.rows.map(r => ({ label: r[0] ?? '', value: num(r[1]), display: r[1] ?? '', tone: toneFor?.(r[0] ?? '') })) }
    const statusBars = toBars(status, k => (/^[45]/.test(k) ? 'bad' : /^2/.test(k) ? 'good' : 'muted'))
    return card('NetworkRequest', 'recording-wide', input, text, {
      summary: fact(facts, /response times/i) ? `Response times: ${fact(facts, /response times/i)}` : 'Network summary',
      facts: [
        { label: 'requests', value: total ?? '?' },
        { label: 'failed', value: String(Number.isFinite(failed) ? failed : 0), tone: failed > 0 ? 'bad' : 'good' },
        { label: 'slow', value: String(Number.isFinite(slow) ? slow : 0), tone: slow > 0 ? 'warn' : undefined },
      ],
      preview: statusBars ? [statusBars] : [{ kind: 'facts', items: facts.slice(0, 5) }],
      sections: [
        ...(types ? [{ id: 'types', title: 'Request types', blocks: [toBars(types)!] }] : []),
        ...(domains ? [{ id: 'domains', title: 'Top domains', blocks: [toBars(domains)!] }] : []),
        { id: 'consumed', title: 'Consumed data', blocks: [{ kind: 'facts', items: facts }] },
      ],
    }, [prompt(failed > 0 ? 'List failed requests' : 'Browse requests', `Use the Replay MCP NetworkRequest tool with mode 'requests'${failed > 0 ? ' and focus on failed (status >= 400) requests' : ''}${on(input)}.`)])
  }
  if (m === 'detail') {
    const g = genericCard('NetworkRequest', input, text, 'request-scoped')
    const status = fact(facts, /status/i)
    return { ...g, summary: truncate(fact(facts, /url/i) ?? g.summary, 80), facts: facts.slice(0, 3).map(f => (/status/i.test(f.label) ? { ...f, tone: statusTone(status ?? '') } : f)) }
  }
  void rest
  return genericCard('NetworkRequest', input, text)
}

// -------------------------------------------------------- UserInteractions

/** User events: the click/key timeline, or the list of interactions with their points. */
const userInteractions: CardParser = (input, text) => {
  const facts = boldFacts(text)
  const table = tables(text)[0]
  if (mode(input, 'summary') === 'interactions' && table) {
    const ci = (re: RegExp) => table.columns.findIndex(c => re.test(c))
    const [iTime, iType, iDetail, iPoint] = [ci(/time/i), ci(/type/i), ci(/detail/i), ci(/point/i)]
    const items = table.rows.map(r => ({ badge: (r[iType] ?? '').toUpperCase().slice(0, 5), tone: 'info' as Tone, text: `${r[iTime] ?? ''}  ${r[iDetail] ?? ''}`, detail: r[iPoint] ?? '' }))
    const firstPoint = table.rows[0]?.[iPoint]
    return card('UserInteractions', 'recording-wide', input, text, {
      summary: /Showing[^*]+/.exec(text)?.[0]?.trim() ?? `${table.rows.length} interactions`,
      facts: [{ label: 'interactions', value: String(table.rows.length), tone: 'info' }],
      preview: [{ kind: 'list', items: items.slice(0, 10) }],
      sections: [
        ...(items.length > 10 ? [{ id: 'all', title: `All ${items.length}`, blocks: [{ kind: 'list', items }] as Block[] }] : []),
        { id: 'consumed', title: 'Consumed data', blocks: [{ kind: 'table', columns: table.columns, rows: table.rows }] },
      ],
    }, firstPoint ? [prompt(`Describe ${firstPoint}`, `Use the Replay MCP DescribePoint tool with point ${firstPoint}${on(input)} to see the code that handled this interaction.`)] : [])
  }
  if (!facts.length) return genericCard('UserInteractions', input, text)
  const timeline = tables(section(text, /timeline/i) ?? '')[0]
  return card('UserInteractions', 'recording-wide', input, text, {
    summary: fact(facts, /time range/i) ? `Between ${fact(facts, /time range/i)}` : 'User interactions',
    status: num(fact(facts, /total/i)) === 0 ? 'empty' : 'complete',
    facts: [
      { label: 'interactions', value: fact(facts, /total/i) ?? '?', tone: 'info' },
      { label: 'clicks', value: fact(facts, /clicks/i) ?? '0' },
      { label: 'keys', value: fact(facts, /key/i) ?? '0' },
    ],
    preview: timeline
      ? [{ kind: 'bars', items: timeline.rows.map(r => ({ label: r[0] ?? '', value: num(r[r.length - 1]), display: r[r.length - 1] ?? '', tone: 'info' as Tone })) }]
      : [],
    sections: [{ id: 'consumed', title: 'Consumed data', blocks: [{ kind: 'facts', items: facts }] }],
  }, [prompt('List interactions', `Use the Replay MCP UserInteractions tool with mode 'interactions'${on(input)}.`)])
}

// ------------------------------------------------------------ LocalStorage

/** localStorage reads/writes: counts, or the operation list. */
const localStorage: CardParser = (input, text) => {
  const facts = boldFacts(text)
  const total = num(fact(facts, /total/i))
  const table = tables(text)[0]
  if (total === 0 || /No localStorage accesses/i.test(text)) {
    return card('LocalStorage', 'recording-wide', input, text, { summary: 'No localStorage accesses', status: 'empty', facts: [{ label: 'accesses', value: '0' }], preview: [{ kind: 'text', text: 'The app did not read or write localStorage.', tone: 'muted' }] })
  }
  if (!facts.length && !table) return genericCard('LocalStorage', input, text)
  return card('LocalStorage', 'recording-wide', input, text, {
    summary: mode(input, 'summary') === 'operations' ? 'Storage operations' : 'Storage summary',
    facts: facts.slice(0, 3),
    preview: table ? [{ kind: 'table', columns: table.columns, rows: table.rows.slice(0, 10) }] : [{ kind: 'facts', items: facts }],
    sections: [{ id: 'consumed', title: 'Consumed data', blocks: table ? [{ kind: 'table', columns: table.columns, rows: table.rows }] : [{ kind: 'facts', items: facts }] }],
  }, [prompt('List operations', `Use the Replay MCP LocalStorage tool with mode 'operations'${on(input)}.`)])
}

// ------------------------------------------------------------- Annotations

/** Annotation kinds with counts, or one kind's timestamped entries. */
const annotations: CardParser = (input, text) => {
  const kinds = [...text.matchAll(/^•\s*(.+?):\s*(\d+)\s+annotations?/gm)].map(m => ({ kind: m[1]!, count: Number(m[2]) }))
  if (kinds.length) {
    return card('Annotations', 'recording-wide', input, text, {
      summary: `${kinds.length} annotation kinds`,
      facts: [{ label: 'kinds', value: String(kinds.length) }, { label: 'annotations', value: String(kinds.reduce((a, k) => a + k.count, 0)) }],
      preview: [{ kind: 'bars', items: kinds.slice(0, 10).map(k => ({ label: k.kind, value: k.count, display: String(k.count) })) }],
      sections: [{ id: 'consumed', title: 'Consumed data', blocks: [{ kind: 'list', items: kinds.map(k => ({ text: k.kind, detail: String(k.count) })) }] }],
    }, [prompt(`Show ${truncate(kinds[0]!.kind, 24)}`, `Use the Replay MCP Annotations tool with kind "${kinds[0]!.kind}"${on(input)}.`)])
  }
  const entries = [...text.matchAll(/^\[(\d+)\]\s+(\d+)ms\s+\((Point:\d+)\):\s*(.*)$/gm)]
  if (entries.length) {
    const header = /^(\d+)\s+"([^"]+)"\s+annotation/m.exec(text)
    return card('Annotations', 'recording-wide', input, text, {
      summary: header ? `${header[1]} “${header[2]}” annotations` : 'Annotations',
      facts: [{ label: 'shown', value: String(entries.length) }, ...(header ? [{ label: 'total', value: header[1]! }] : [])],
      preview: [{ kind: 'list', items: entries.slice(0, 10).map(e => ({ text: truncate(e[4]!, 140), detail: `${ms(Number(e[2]))} ${e[3]}` })) }],
      sections: [{ id: 'consumed', title: 'Consumed data', blocks: [{ kind: 'list', items: entries.map(e => ({ text: e[4]!, detail: `${e[2]}ms ${e[3]}` })) }] }],
    })
  }
  return genericCard('Annotations', input, text)
}

// -------------------------------------------------------------- Screenshot

/** The screenshot image at a moment, with the mouse position and next point. */
const screenshot: CardParser = (input, text) => {
  const m = /Screenshot at timestamp\s+(\d+):\s*(\S+)/.exec(text)
  if (!m) return genericCard('Screenshot', input, text)
  const mouse = /Mouse position:\s*(.+)/.exec(text)?.[1]
  const sinceClick = /Time since last click:\s*([\d.]+)ms/.exec(text)?.[1]
  const next = /Next execution point:\s*(Point:\d+)\s*@\s*([\d.]+)ms/.exec(text)
  return card('Screenshot', 'point-scoped', input, text, {
    summary: `At ${ms(Number(m[1]))}`,
    facts: [
      { label: 'time', value: ms(Number(m[1])) },
      ...(mouse ? [{ label: 'mouse', value: mouse }] : []),
      ...(sinceClick ? [{ label: 'since last click', value: ms(Number(sinceClick)) }] : []),
    ],
    preview: [{ kind: 'image', url: m[2]!, caption: `Screenshot at ${ms(Number(m[1]))}` }],
    sections: [{ id: 'consumed', title: 'Consumed data', blocks: [{ kind: 'facts', items: [{ label: 'url', value: m[2]! }, ...(next ? [{ label: 'next point', value: `${next[1]} @ ${ms(Number(next[2]))}` }] : [])] }] }],
  }, [
    { kind: 'url', label: 'Open image', url: m[2]! },
    ...(next ? [prompt(`Describe ${next[1]}`, `Use the Replay MCP DescribePoint tool with point ${next[1]}${on(input)}.`)] : []),
  ])
}

// --------------------------------------------------------- PlaywrightSteps

/** Playwright tests and steps, with failures flagged. */
const playwrightSteps: CardParser = (input, text) => {
  if (/No playwright steps found/i.test(text) || !text.trim()) {
    return card('PlaywrightSteps', 'recording-wide', input, text, { summary: 'No Playwright steps in this recording', status: 'empty', preview: [{ kind: 'text', text: 'This recording was not made by a Playwright test.', tone: 'muted' }] })
  }
  const table = tables(text)[0]
  const g = genericCard('PlaywrightSteps', input, text)
  if (!table) return g
  const failed = table.rows.filter(r => r.some(c => /fail|error|✗|❌/i.test(c)))
  return {
    ...g,
    facts: [{ label: 'rows', value: String(table.rows.length) }, { label: 'failed', value: String(failed.length), tone: failed.length ? 'bad' : 'good' }],
    preview: [{ kind: 'table', columns: table.columns, rows: table.rows.slice(0, 10), tones: table.rows.slice(0, 10).map(r => (failed.includes(r) ? 'bad' : undefined)) }],
  }
}

// ------------------------------------------------------------ Exceptions

/** Uncaught exceptions / React render failures: message and stack, or a calm empty card. */
function exceptionParser(tool: 'UncaughtException' | 'ReactException', noun: string): CardParser {
  return (input, text) => {
    if (!text.trim() || /^no (uncaught|react)/i.test(text.trim())) {
      return card(tool, 'recording-wide', input, text, { summary: `No ${noun}`, status: 'empty', preview: [{ kind: 'text', text: `No ${noun} happened in this recording.`, tone: 'good' }] })
    }
    const g = genericCard(tool, input, text, 'point-scoped')
    const message = boldFacts(text).find(f => /message|error/i.test(f.label))?.value ?? plain(text.split('\n').find(l => l.trim() && !l.startsWith('#')) ?? '')
    const frames = text.split('\n').map(l => /^\s*(?:\d+\.\s*)?at\s+(.+)$/.exec(l)?.[1]).filter((x): x is string => Boolean(x))
    const point = /Point:\d+/.exec(text)?.[0]
    const preview: Block[] = [
      { kind: 'text', text: truncate(message, 240), tone: 'bad' },
      ...(frames.length ? [{ kind: 'list', items: frames.slice(0, 6).map(f => ({ text: f })) } as Block] : []),
    ]
    const extra: Action[] = point
      ? [prompt(`Describe ${point}`, `Use the Replay MCP DescribePoint tool with point ${point}${on(input)} to explain this ${noun.replace(/s$/, '')}.`)]
      : [prompt('Find the root cause', `Find the root cause of this ${noun.replace(/s$/, '')} using the Replay MCP tools${on(input)}.`)]
    return {
      ...g,
      summary: truncate(message || g.summary, 80),
      status: 'complete',
      facts: [{ label: 'exception', value: truncate(message, 40), tone: 'bad' }, ...(frames.length ? [{ label: 'frames', value: String(frames.length) }] : []), ...(point ? [{ label: 'point', value: point }] : [])],
      preview,
      actions: baseActions(input, text, extra),
      sections: g.sections.some(s => s.id === 'consumed') ? g.sections : [{ id: 'consumed', title: 'Consumed data', blocks: [{ kind: 'markdown', text: truncate(text, 3000) }] } as Section, ...g.sections],
    }
  }
}

export const OVERVIEW_PARSERS: Record<string, CardParser> = {
  RecordingOverview: recordingOverview,
  ConsoleMessages: consoleMessages,
  NetworkRequest: networkRequest,
  UserInteractions: userInteractions,
  LocalStorage: localStorage,
  Annotations: annotations,
  Screenshot: screenshot,
  PlaywrightSteps: playwrightSteps,
  UncaughtException: exceptionParser('UncaughtException', 'uncaught exceptions'),
  ReactException: exceptionParser('ReactException', 'React render exceptions'),
}
