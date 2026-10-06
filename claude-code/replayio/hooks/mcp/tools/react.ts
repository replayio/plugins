// Cards for the React, state-store and profiling tools.

import {
  baseActions,
  boldFacts,
  bullets,
  errorCard,
  fact,
  genericCard,
  ms,
  num,
  plain,
  rawSection,
  section,
  sections,
  type MdTable,
  truncate,
  type Action,
  type Block,
  type Card,
  type CardParser,
  type Scope,
  type Section,
  type Tone,
  type ToolInput,
} from '../card.ts'

const mode = (input: ToolInput, fallback: string) => String(input.mode ?? fallback)

/** "77.9ms", "750µs", "1.2s" -> milliseconds. */
function durMs(s: string | undefined): number {
  const m = /(-?[\d,.]+)\s*(µs|us|ms|s)\b/.exec(s ?? '')
  if (!m) return NaN
  const v = Number(m[1]!.replace(/,/g, ''))
  return m[2] === 's' ? v * 1000 : m[2] === 'ms' ? v : v / 1000
}

/** Library code (node_modules, vite deps, chunks) is drawn muted next to app code. */
const isLibrary = (s: string) => /node_modules|\.vite\/deps|chunk-[A-Z0-9]+\.js/.test(s)

/** Bundler-mangled export names (`$ea39…$export$439d…`). */
const isMangled = (s: string) => /^\$[0-9a-f]+\$export\$/.test(s)

/**
 * Pipe tables, tolerating separator cells with no dashes (`| : | -----: |`),
 * which ReactRenders' commits table uses and card.ts `tables` skips.
 */
function pipeTables(text: string): MdTable[] {
  const out: MdTable[] = []
  const lines = text.split('\n')
  const cells = (line: string) => line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map(c => plain(c.trim()))
  for (let i = 0; i < lines.length - 1; i++) {
    const rule = lines[i + 1]!
    if (!lines[i]!.includes('|') || !rule.includes('-') || !/^\s*\|?(\s*:?-*:?\s*\|)+\s*:?-*:?\s*\|?\s*$/.test(rule)) continue
    const rows: string[][] = []
    let j = i + 2
    for (; j < lines.length && lines[j]!.includes('|') && lines[j]!.trim() !== ''; j++) rows.push(cells(lines[j]!))
    out.push({ columns: cells(lines[i]!), rows })
    i = j - 1
  }
  return out
}

const notFound = (text: string) => /not found in this recording|requires a recording/i.test(text)

function card(tool: string, scope: Scope, input: ToolInput, text: string, c: Partial<Card> & Pick<Card, 'summary'>, extra: Action[] = []): Card {
  return {
    tool,
    title: tool,
    status: 'complete',
    scope,
    facts: [],
    preview: [],
    sections: [rawSection(text)],
    ...c,
    actions: baseActions(input, text, extra),
  }
}

const prompt = (label: string, input: ToolInput, ask: string): Action => ({
  kind: 'prompt',
  label,
  text: `${ask}${input.recordingId ? ` (Replay recording ${input.recordingId})` : ''}`,
})

// ------------------------------------------------------------- ReactRenders

/** Summary: costliest commits as bars. commits: the paginated table. commit: one commit's anatomy. */
const reactRenders: CardParser = (input, text) => {
  const tool = 'ReactRenders'
  const m = mode(input, 'summary')
  const facts = boldFacts(text)

  if (/^#\s*Commit #\d+/m.test(text) || m === 'commit') {
    const index = /#\s*Commit #(\d+)/.exec(text)?.[1] ?? String(input.commitIndex ?? '?')
    const components = pipeTables(section(text, /^Components/) ?? '')[0]
    const rows = (components?.rows ?? [])
      .map(r => ({ name: r[0] ?? '', renders: num(r[2]), wasted: num(r[3]), d: durMs(r[4]) }))
      .filter(r => Number.isFinite(r.d))
      .sort((a, b) => b.d - a.d)
    const triggers = sections(text).find(s => /^Triggers/.test(s.title))?.body ?? ''
    const triggerItems = triggers
      .split(/\n(?=- \*\*)/)
      .map(t => t.trim())
      .filter(t => t.startsWith('- **'))
      .map(t => {
        const kind = plain(/- \*\*([^*]+)\*\*/.exec(t)?.[1] ?? 'Trigger')
        const source = /Source:\s*(.+)/.exec(t)?.[1]
        const point = /Point:\s*(\S+)/.exec(t)?.[1]
        return { text: kind, detail: [source, point && `point ${truncate(point, 14)}`].filter(Boolean).join(' · ') }
      })
    const phase = boldFacts(section(text, /Phase Breakdown/) ?? '')
    const mutations = bullets(section(text, /^DOM Mutations/) ?? '')
    const fibers = fact(facts, /Fibers rendered/) ?? ''
    return card(tool, 'profile-scoped', input, text, {
      title: `${tool} · commit #${index}`,
      summary: `${fact(facts, /Render duration/) ?? '?'} render at ${fact(facts, /Timestamp/) ?? '?'}`,
      facts: [
        { label: 'render', value: fact(facts, /Render duration/) ?? '?', tone: durMs(fact(facts, /Render duration/)) > 16 ? 'warn' : undefined },
        { label: 'fibers', value: fibers.replace(/\s*\(.*$/, '') },
        { label: 'wasted', value: /(\d+) wasted/.exec(fibers)?.[1] ?? '0', tone: /— ([\d.]+)%/.exec(fibers) && num(/— ([\d.]+)%/.exec(fibers)![1]) > 50 ? 'warn' : undefined },
      ],
      preview: rows.length
        ? [{ kind: 'bars', items: rows.slice(0, 8).map(r => ({ label: r.name, value: r.d, display: `${ms(r.d)}${r.wasted ? ` · ${r.wasted} wasted` : ''}`, tone: isMangled(r.name) ? 'muted' : r.wasted > 0 && r.wasted === r.renders ? 'warn' : undefined })) }]
        : [],
      sections: [
        { id: 'triggers', title: `Triggers (${triggerItems.length})`, blocks: [{ kind: 'list', items: triggerItems }] },
        { id: 'phases', title: 'Phase breakdown', blocks: [{ kind: 'facts', items: phase }] },
        ...(components ? [{ id: 'components', title: `Components (${components.rows.length})`, blocks: [{ kind: 'table' as const, columns: components.columns, rows: components.rows.slice(0, 40), numeric: components.columns.map((_, i) => i > 0) }] }] : []),
        ...(mutations.length ? [{ id: 'mutations', title: 'DOM mutations', blocks: [{ kind: 'list' as const, items: mutations.map(t => ({ text: t })) }] }] : []),
        rawSection(text),
      ],
    }, rows[0] ? [prompt(`Why ${truncate(rows[0].name, 18)}?`, input, `Use ReactRenders mode=component&componentName=${rows[0].name} to find out why ${rows[0].name} re-rendered in commit #${index}`)] : [])
  }

  const table = pipeTables(text)[0]
  if (m === 'commits' || (table && /Duration/.test(table.columns.join(' ')) && /Trigger/.test(table.columns.join(' ')))) {
    if (!table) return genericCard(tool, input, text, 'profile-scoped')
    const col = (re: RegExp) => table.columns.findIndex(c => re.test(c))
    const wi = col(/Waste%/)
    const di = col(/Duration/)
    const heaviest = [...table.rows].sort((a, b) => durMs(b[di]) - durMs(a[di]))[0]
    const showing = /Showing ([^\n]+)/.exec(text)?.[1]
    return card(tool, 'profile-scoped', input, text, {
      title: `${tool} · commits`,
      summary: showing ? plain(showing) : `${table.rows.length} commits`,
      facts: heaviest ? [{ label: 'heaviest', value: `#${heaviest[0]} ${heaviest[di]}`, tone: durMs(heaviest[di]) > 16 ? 'warn' : undefined }] : [],
      preview: [{
        kind: 'table',
        columns: table.columns,
        rows: table.rows.slice(0, 10),
        numeric: table.columns.map(c => /^#$|Time|Duration|Fibers|Mutating|Wasted|Waste%/.test(c)),
        tones: table.rows.slice(0, 10).map((r): Tone | undefined => (num(r[wi]) > 50 ? 'warn' : undefined)),
      }],
      sections: [
        ...(table.rows.length > 10 ? [{ id: 'all', title: `All ${table.rows.length} rows`, blocks: [{ kind: 'table' as const, columns: table.columns, rows: table.rows }] }] : []),
        rawSection(text),
      ],
    }, heaviest ? [prompt(`Inspect commit #${heaviest[0]}`, input, `Use ReactRenders mode=commit&commitIndex=${heaviest[0]} to inspect the heaviest commit`)] : [])
  }

  if (m === 'summary' || /React Renders Summary/.test(text)) {
    const commits = [...text.matchAll(/^\s*(\d+)\.\s+t=([\d.]+s)\s+—\s+([\d.]+ms) render time,\s+(\d+) fibers\s+—\s+(.+)$/gm)]
    const top = commits[0]
    return card(tool, 'profile-scoped', input, text, {
      summary: 'React commit profile',
      facts: [
        { label: 'commits', value: fact(facts, /^Commits/) ?? '?' },
        { label: 'render time', value: fact(facts, /render time/i) ?? '?' },
      ],
      preview: commits.length
        ? [{ kind: 'bars', items: commits.map(c => ({ label: `#${c[1]} @ ${c[2]} ${plain(c[5]!)}`, value: num(c[3]), display: `${c[3]} · ${c[4]} fibers`, tone: num(c[3]) > 16 ? 'warn' : undefined })) }]
        : [],
      sections: [rawSection(text)],
    }, top ? [prompt(`Inspect commit #${top[1]}`, input, `Use ReactRenders mode=commit&commitIndex=${top[1]} to inspect the costliest React commit`)] : [])
  }

  // component / waste-rank and other modes: tables and facts, generically.
  return genericCard(tool, input, text, 'profile-scoped')
}

// ------------------------------------------------------- ReactComponentTree

/** Summary: instance counts as bars. tree/subtree: the ▼/▶ hierarchy. */
const reactComponentTree: CardParser = (input, text) => {
  const tool = 'ReactComponentTree'
  const treeLines = text.split('\n').filter(l => /^\s*[▼▶]\s/.test(l))
  if (treeLines.length) {
    const lines = treeLines.map(l => {
      const indent = /^\s*/.exec(l)![0].length
      const m = /^\s*([▼▶])\s+(.*?)(?:\s+\((Fiber:\d+)\))?(?:\s+\[(.+)\])?\s*$/.exec(l)!
      return { depth: Math.floor(indent / 2), text: m[2] ?? l.trim(), detail: [m[3], m[4]].filter(Boolean).join(' '), isOpen: m[1] === '▼' }
    })
    const header = text.split('\n').find(l => l.trim() && !/^\s*[▼▶]/.test(l)) ?? ''
    const visible = /\((\d+) visible of (\d+) total\)/.exec(header)
    return card(tool, 'component-scoped', input, text, {
      summary: header ? plain(header) : 'Component hierarchy',
      facts: visible ? [{ label: 'visible', value: visible[1]! }, { label: 'components', value: visible[2]! }] : [],
      preview: [{ kind: 'tree', lines: lines.slice(0, 14) }],
      sections: [
        ...(lines.length > 14 ? [{ id: 'tree', title: `Full tree (${lines.length})`, blocks: [{ kind: 'tree' as const, lines }] }] : []),
        rawSection(text),
      ],
    }, [prompt('Expand a subtree', input, `Use ReactComponentTree mode=subtree on ${lines.find(l => l.isOpen === false)?.text ?? 'the collapsed component'} to see its children`)])
  }

  if (/Component Tree Summary/.test(text) || mode(input, 'summary') === 'summary') {
    const facts = boldFacts(text)
    const counts = (section(text, /Instance Count/) ?? '')
      .split('\n')
      .map(l => /^\s*-\s+(.+):\s*(\d+)\s*$/.exec(l))
      .filter((m): m is RegExpExecArray => Boolean(m))
      .map(m => ({ name: plain(m[1]!), count: Number(m[2]) }))
    const minified = counts.filter(c => isMangled(c.name)).reduce((a, c) => a + c.count, 0)
    const named = counts.filter(c => !isMangled(c.name))
    const items = [...named, ...(minified ? [{ name: 'Anonymous/minified', count: minified }] : [])].sort((a, b) => b.count - a.count)
    if (!items.length && !facts.length) return genericCard(tool, input, text, 'component-scoped')
    return card(tool, 'component-scoped', input, text, {
      summary: `Root: ${fact(facts, /Root/) ?? '?'}`,
      facts: [
        { label: 'components', value: fact(facts, /Total components/) ?? '?' },
        { label: 'max depth', value: fact(facts, /Max depth/) ?? '?' },
      ],
      preview: items.length ? [{ kind: 'bars', items: items.slice(0, 8).map(c => ({ label: c.name, value: c.count, display: `×${c.count}`, tone: c.name === 'Anonymous/minified' ? 'muted' : undefined })) }] : [],
      sections: [
        { id: 'consumed', title: 'Consumed data', blocks: [{ kind: 'table', columns: ['Component', 'Instances'], rows: counts.map(c => [c.name, String(c.count)]), numeric: [false, true] }] },
        rawSection(text),
      ],
    }, [prompt('Show the tree', input, 'Use ReactComponentTree mode=tree to see the component hierarchy')])
  }
  return genericCard(tool, input, text, 'component-scoped')
}

// ------------------------------------------------- ReactPerformanceInsights

const SEVERITY: Record<string, { tone: Tone; badge: string }> = {
  '🔴': { tone: 'bad', badge: '●' },
  '🟠': { tone: 'warn', badge: '●' },
  '🟡': { tone: 'warn', badge: '●' },
  '🟢': { tone: 'good', badge: '●' },
  '🔵': { tone: 'info', badge: '●' },
}

/** Summary facts and severity-badged findings, each finding's detail in a section. */
const reactPerformanceInsights: CardParser = (input, text) => {
  const tool = 'ReactPerformanceInsights'
  const summary = boldFacts(section(text, /^Summary/) ?? '')
  const findings = sections(text)
    .filter(s => s.level >= 3)
    .map(s => {
      const raw = text.split('\n').find(l => /^#{3,}\s/.test(l) && plain(l.replace(/^#+\s*/, '')) === s.title) ?? ''
      const emoji = [...raw].find(ch => ch in SEVERITY) ?? /^(\S+)/.exec(s.title)?.[1] ?? ''
      const title = s.title.replace(/^[^\p{L}\p{N}]+/u, '').trim()
      const f = boldFacts(s.body)
      return { title, emoji, body: s.body.replace(/\n---\s*$/, '').trim(), category: fact(f, /^Category/), impact: fact(f, /^Impact/), point: /point\s+(\d{10,})/.exec(fact(f, /Navigate to/) ?? '')?.[1] }
    })
  if (!findings.length && !summary.length) return genericCard(tool, input, text, 'profile-scoped')
  const top = findings[0]
  const count = num(/^#+\s*Findings \((\d+)\)/m.exec(text)?.[1]) || findings.length
  const isDev = /Development build detected/i.test(text)
  return card(tool, 'profile-scoped', input, text, {
    summary: `${count} finding${count === 1 ? '' : 's'}${isDev ? ' · development build' : ''}`,
    status: findings.length ? 'complete' : 'empty',
    facts: [
      { label: 'commits', value: fact(summary, /^Commits/) ?? '?' },
      { label: 'dropped frames', value: fact(summary, /dropped frames/i) ?? '?', tone: num(fact(summary, /dropped frames/i)) > 0 ? 'warn' : 'good' },
      { label: 'wasted', value: fact(summary, /^Wasted renders/) ?? '?' },
    ],
    preview: [{
      kind: 'list',
      items: findings.slice(0, 8).map(f => ({ text: f.title, detail: f.impact, tone: SEVERITY[f.emoji]?.tone ?? 'muted', badge: SEVERITY[f.emoji]?.badge ?? '•' })),
    }],
    sections: [
      ...findings.slice(0, 12).map((f, i): Section => ({ id: `f${i}`, title: truncate(f.title, 40), blocks: [{ kind: 'markdown', text: f.body }] })),
      rawSection(text),
    ],
  }, top ? [prompt('Fix the top finding', input, `Use ReactPerformanceInsights findings to fix: "${top.title}"${top.point ? ` (point ${top.point})` : ''}. Find the responsible code and propose a change`)] : [])
}

// ------------------------------------------------------------ state stores

/**
 * Redux, Zustand and TanStack Query share a shape: a list mode (actions,
 * events, queries) as a table, and a detail mode (one entry, state diff) as
 * facts plus code. Drawn from whatever tables and bold facts the text has.
 */
function stateStore(tool: string, entity: string, nextAsk: (firstId: string) => string): CardParser {
  return (input, text) => {
    if (notFound(text) || /^\[(Error|InputValidation)\]/.test(text.trim())) return errorCard(tool, input, text)
    const facts = boldFacts(text)
    const table = pipeTables(text)[0]
    const heading = sections(text).find(s => s.level === 1)?.title
    const showing = /Showing ([^\n]+)/i.exec(text)?.[1]
    const diff = /```[a-z]*\n([\s\S]*?)```/.exec(text)?.[1]
    const preview: Block[] = table
      ? [{ kind: 'table', columns: table.columns, rows: table.rows.slice(0, 10), numeric: table.columns.map(c => /^#$|Index|Time|Count|Observers/i.test(c)) }]
      : diff
        ? [{ kind: 'code', lines: diff.split('\n').filter(Boolean).slice(0, 14).map(l => ({ text: l, isMarked: /^\+/.test(l), isUnhit: /^-/.test(l) })) }]
        : facts.length
          ? [{ kind: 'facts', items: facts.slice(3, 11) }]
          : [{ kind: 'markdown', text: truncate(text.trim(), 900) }]
    const first = table?.rows[0]?.[0]
    return card(tool, 'recording-wide', input, text, {
      summary: heading ?? (showing ? plain(showing) : `${entity} in this recording`),
      facts: facts.slice(0, 3),
      preview,
      sections: [
        ...(table && table.rows.length > 10 ? [{ id: 'all', title: `All ${table.rows.length} ${entity}`, blocks: [{ kind: 'table' as const, columns: table.columns, rows: table.rows }] }] : []),
        ...(diff && table ? [{ id: 'diff', title: 'State diff', blocks: [{ kind: 'code' as const, lines: diff.split('\n').map(l => ({ text: l })) }] }] : []),
        rawSection(text),
      ],
    }, first ? [prompt(`Inspect ${truncate(first, 16)}`, input, nextAsk(first))] : [])
  }
}

// ---------------------------------------------------------------- profiles

/** Flat profile `name (url:line:col): N hits` lines as bars; header facts; continuation point. */
const profileStatements: CardParser = (input, text) => {
  const tool = 'ProfileStatements'
  const head = /Profile from ([\d.]+)ms to ([\d.]+)ms/.exec(text)
  const total = /Total breakpoint hits:\s*([\d,]+)/.exec(text)?.[1]
  const unique = /Unique functions:\s*([^\n]+)/.exec(text)?.[1]
  const cont = /Use (Point:\d+) to continue/.exec(text)?.[1]
  const flat = (text.split(/^Call tree:/m)[0] ?? text)
    .split('\n')
    .map(l => /^\s{2}(\S.*?) \((.+)\): ([\d,]+) hits/.exec(l))
    .filter((m): m is RegExpExecArray => Boolean(m))
    .map(m => ({ name: m[1]!, loc: m[2]!, hits: num(m[3]) }))
  if (!flat.length) return genericCard(tool, input, text, 'profile-scoped')
  const shortLoc = (loc: string) => loc.replace(/^https?:\/\/[^/]+/, '').replace(/^.*node_modules\/(?:\.pnpm\/[^/]+\/node_modules\/)?/, '').replace(/\?v=[0-9a-f]+/, '')
  const appFns = flat.filter(f => !isLibrary(f.loc))
  return card(tool, 'profile-scoped', input, text, {
    summary: head ? `Statement hits from ${ms(num(head[1]))} to ${ms(num(head[2]))}` : 'Statement profile',
    status: cont ? 'partial' : 'complete',
    facts: [
      { label: 'hits', value: total ?? '?' },
      { label: 'functions', value: (unique ?? '?').replace(/\s*\(.*$/, '') },
      ...(cont ? [{ label: 'continue from', value: cont, tone: 'warn' as const }] : []),
    ],
    preview: [{ kind: 'bars', items: flat.slice(0, 8).map(f => ({ label: f.name, value: f.hits, display: `${f.hits.toLocaleString()} · ${truncate(shortLoc(f.loc), 30)}`, tone: isLibrary(f.loc) ? 'muted' : 'accent' })) }],
    sections: [
      ...(appFns.length ? [{ id: 'app', title: `App code (${appFns.length})`, blocks: [{ kind: 'bars' as const, items: appFns.slice(0, 15).map(f => ({ label: f.name, value: f.hits, display: `${f.hits.toLocaleString()} · ${truncate(shortLoc(f.loc), 30)}` })) }] }] : []),
      { id: 'consumed', title: `Consumed data (${flat.length} functions)`, blocks: [{ kind: 'table', columns: ['Function', 'Hits', 'Location'], rows: flat.slice(0, 50).map(f => [f.name, f.hits.toLocaleString(), shortLoc(f.loc)]), numeric: [false, true, false] }] },
      rawSection(text),
    ],
  }, cont ? [prompt(`Continue from ${cont}`, input, `Use ProfileStatements with beginPoint=${cont} to continue profiling the rest of the recording`)] : [])
}

/** Native frames (C++ symbols, addresses, runtime glue) that hide the JS call tree. */
const isNative = (frame: string) =>
  /^_?_Z|^ReplaySpace\+|^0x[0-9a-f]+$|^\(nil\)$|^InvokeOnNewStack$|^_?ChromeMain$|^Chromium\.|^\.\.\. /.test(frame)

/** The call tree with native frames collapsed, plus the JS frame distribution. */
const profileSampling: CardParser = (input, text) => {
  const tool = 'ProfileSampling'
  const head = /Profile from ([\d.]+)ms to ([\d.]+)ms/.exec(text)
  const samples = /Total samples:\s*([\d,]+)/.exec(text)?.[1]
  const [treePart = '', distPart = ''] = (text.split(/^Call tree:/m)[1] ?? '').split(/^JS frame distribution:/m)
  const nodes = treePart
    .split('\n')
    .map(l => /^(\s*)([\d.]+)ms: (.+)$/.exec(l))
    .filter((m): m is RegExpExecArray => Boolean(m))
    .map(m => ({ indent: m[1]!.length, ms: num(m[2]), frame: m[3]!.trim() }))
  // Keep JS frames; their depth is how many kept frames enclose them.
  const kept: { depth: number; text: string; detail: string }[] = []
  const stack: number[] = []
  for (const n of nodes) {
    if (isNative(n.frame)) continue
    while (stack.length && stack[stack.length - 1]! >= n.indent) stack.pop()
    kept.push({ depth: stack.length, text: truncate(n.frame.replace(/\s*\(https?:\/\/[^)]*\)/, ''), 60), detail: ms(n.ms) })
    stack.push(n.indent)
  }
  const dist = distPart
    .split('\n')
    .map(l => /^\s*([\d.]+)ms: (.+)$/.exec(l))
    .filter((m): m is RegExpExecArray => Boolean(m))
    .map(m => ({ ms: num(m[1]), name: m[2]!.replace(/\s*\(https?:\/\/[^)]*\)/, ''), isLib: isLibrary(m[2]!) }))
  if (!nodes.length && !dist.length) return genericCard(tool, input, text, 'profile-scoped')
  const native = nodes.filter(n => isNative(n.frame)).length
  return card(tool, 'profile-scoped', input, text, {
    summary: head ? `Sampled ${ms(num(head[1]))}–${ms(num(head[2]))}` : 'Sampled CPU profile',
    facts: [
      { label: 'samples', value: samples ?? '?' },
      { label: 'JS frames', value: String(kept.length) },
      { label: 'native frames hidden', value: String(native), tone: 'muted' },
    ],
    preview: dist.length
      ? [{ kind: 'bars', items: dist.slice(0, 8).map(d => ({ label: d.name, value: d.ms, display: ms(d.ms), tone: d.isLib ? 'muted' : 'accent' })) }]
      : kept.length
        ? [{ kind: 'tree', lines: kept.slice(0, 12) }]
        : [{ kind: 'text', text: 'Only native frames above the sampling threshold.', tone: 'muted' }],
    sections: [
      ...(kept.length ? [{ id: 'tree', title: `Call tree (${kept.length} JS frames)`, blocks: [{ kind: 'tree' as const, lines: kept.slice(0, 80) }] }] : []),
      rawSection(text),
    ],
  }, [prompt('Profile statements', input, 'Use ProfileStatements over the hottest range to see which statements ran most')])
}

/** Top-level sources with their share as bars; nested ReactRender entries per source in sections. */
const profileGraph: CardParser = (input, text) => {
  const tool = 'ProfileGraph'
  const head = /Graph profile from ([\d.]+)ms to ([\d.]+)ms/.exec(text)
  const total = /Total execution:\s*([^\n]+)/.exec(text)?.[1]
  const entry = /^(\s*)(.+?)(?: x (\d+))? @ ([\d.]+)ms(?: point:(\d+))?: (\d+) \(([\d.]+)%\)\s*$/
  const tops: { name: string; at: string; units: number; pct: number; children: { name: string; count?: string; units: number; pct: number; point?: string }[] }[] = []
  for (const line of text.split('\n')) {
    const m = entry.exec(line)
    if (!m) continue
    if (m[1]!.length === 0) tops.push({ name: m[2]!, at: m[4]!, units: num(m[6]), pct: num(m[7]), children: [] })
    else tops[tops.length - 1]?.children.push({ name: m[2]!.trim(), count: m[3], units: num(m[6]), pct: num(m[7]), point: m[5] })
  }
  if (!tops.length) return genericCard(tool, input, text, 'profile-scoped')
  const withChildren = tops.filter(t => t.children.length)
  return card(tool, 'profile-scoped', input, text, {
    summary: head ? `Execution ${ms(num(head[1]))}–${ms(num(head[2]))}` : 'Execution graph',
    facts: [
      { label: 'duration', value: head ? ms(num(head[2]) - num(head[1])) : '?' },
      { label: 'execution', value: (total ?? '?').replace(/ progress units.*/, ' units') },
    ],
    preview: [{ kind: 'bars', items: tops.slice(0, 8).map(t => ({ label: t.name, value: t.pct, display: `${t.pct}% @ ${ms(num(t.at))}` })) }],
    sections: [
      ...withChildren.slice(0, 4).map((t, i): Section => ({
        id: `src${i}`,
        title: truncate(t.name, 32),
        blocks: [{ kind: 'bars', items: t.children.map(c => ({ label: `${c.name}${c.count ? ` ×${c.count}` : ''}`, value: c.pct, display: `${c.pct}%`, tone: /^ReactRender/.test(c.name) ? 'info' : undefined })) }],
      })),
      rawSection(text),
    ],
  }, withChildren[0]?.children[0]?.point
    ? [prompt(`Inspect ${truncate(withChildren[0].children[0].name, 18)}`, input, `Use DescribePoint on point ${withChildren[0].children[0].point} (${withChildren[0].children[0].name}) to see what it did`)]
    : [])
}

export const REACT_PARSERS: Record<string, CardParser> = {
  ReactRenders: reactRenders,
  ReactComponentTree: reactComponentTree,
  ReactPerformanceInsights: reactPerformanceInsights,
  ReduxActions: stateStore('ReduxActions', 'actions', id => `Use ReduxActions mode=action&actionIndex=${id} to see that action's payload and state diff`),
  ZustandStores: stateStore('ZustandStores', 'stores', id => `Use ZustandStores with storeId=${id} to see that store's mutations`),
  TanStackQueries: stateStore('TanStackQueries', 'queries', id => `Use TanStackQueries with queryHash=${id} to see that query's lifecycle`),
  ProfileStatements: profileStatements,
  ProfileSampling: profileSampling,
  ProfileGraph: profileGraph,
}

