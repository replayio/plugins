// Cards for the point-scoped and source-scoped Replay MCP tools: what ran at a
// moment (DescribePoint, Evaluate, GetStack, GetPointComponent, GetPointLink,
// InspectElement, Logpoint) and the code itself (ListSources, ReadSource,
// SearchSources, ExecutionDelay).

import {
  baseActions,
  genericCard,
  ms,
  num,
  plain,
  rawSection,
  truncate,
  type Block,
  type Card,
  type CardParser,
  type CodeLine,
  type Fact,
  type Tone,
  type ToolInput,
} from '../card.ts'

// ------------------------------------------------------------------ helpers

const isLibrary = (location: string) => /node_modules|\.vite\/deps|\/@vite\/|\/@react-refresh|record-replay-/.test(location)

/** The path relative to its origin, so `http://127.0.0.1:4173/src/a.tsx` reads `/src/a.tsx`. */
function shortPath(url: string): string {
  const m = /^[a-z]+:\/\/[^/]+(\/.*)$/i.exec(url.trim())
  const path = m ? m[1]! : url.trim()
  return path.replace(/^\/@fs\/.*?\/(packages|src|node_modules)\//, '/$1/')
}

const fileName = (url: string) => url.split(/[/?#]/).filter(Boolean).pop() ?? url

/** Rows of a `hits | L | code` table: `*` marks the requested line, `/*<HIT>*\/` a breakpoint that ran. */
function codeLines(text: string): CodeLine[] {
  const lines: CodeLine[] = []
  for (const raw of text.split('\n')) {
    const m = /^\s*(\d*)\s*\|\s*(\*?)(\d+)\s*\|(.*)$/.exec(raw)
    if (!m) continue
    const hits = m[1] ?? ''
    lines.push({
      n: Number(m[3]),
      hits,
      text: (m[4] ?? '').replace(/^ /, '').replace(/\/\*<HIT>\*\//g, '').replace(/\s+$/, ''),
      isMarked: m[2] === '*',
      isUnhit: hits === '0',
    })
  }
  return lines
}

/** Keeps the marked lines and up to `around` lines on either side, at most `max` lines. */
function aroundMarked(lines: CodeLine[], around: number, max: number): CodeLine[] {
  const marked = lines.map((l, i) => (l.isMarked ? i : -1)).filter(i => i >= 0)
  if (marked.length === 0) return lines.slice(0, max)
  const keep = new Set<number>()
  for (const i of marked) for (let j = i - around; j <= i + around; j++) if (j >= 0 && j < lines.length) keep.add(j)
  return [...keep].sort((a, b) => a - b).slice(0, max).map(i => lines[i]!)
}

/** `Point:N` as given; a raw execution point (a long number) shortened to its tail. */
const pointLabel = (input: ToolInput) => {
  if (typeof input.point !== 'string') return undefined
  return /^\d{12,}$/.test(input.point) ? `point …${input.point.slice(-6)}` : input.point
}

function card(tool: string, partial: Omit<Card, 'tool' | 'title'> & { title?: string }): Card {
  return { tool, title: partial.title ?? tool, ...partial }
}

// ------------------------------------------------------------------- parsers

/** DescribePoint: the function around the point, which statements ran, and its variables. */
const describePoint: CardParser = (input, text) => {
  const time = /Timestamp:\s*([\d.]+)ms/.exec(text)
  const origin = /^Source:\s*(.+)$/m.exec(text)
  const fence = /```[a-z]*\n([\s\S]*?)```/.exec(text)
  const vars = [...text.matchAll(/Variable (\S+) has contents ([\s\S]*?)(?=\n\s*\n|\nVariable |\nSource:|$)/g)].map(m => ({
    name: m[1]!,
    value: m[2]!.trim(),
  }))
  if (!fence && vars.length === 0) return genericCard('DescribePoint', input, text, 'point-scoped')
  // The code annotates each statement with a comment line: keep the code, mark what did not run.
  const lines: CodeLine[] = []
  let ran: boolean | undefined
  for (const line of (fence?.[1] ?? '').split('\n')) {
    const note = /^\s*\/\/ This statement was (not )?executed/.exec(line)
    if (note) {
      ran = !note[1]
      continue
    }
    if (!line.trim()) continue
    lines.push({ text: line, isUnhit: ran === false })
    ran = undefined
  }
  const fn = /^\s*(?:async\s+)?function\s*\*?\s*([\w$]*)/.exec(lines[0]?.text ?? '')?.[1]
  const facts: Fact[] = []
  if (time) facts.push({ label: 'at', value: ms(Number(time[1])), tone: 'info' })
  if (fn) facts.push({ label: 'function', value: fn, tone: 'accent' })
  if (vars.length) facts.push({ label: vars.length === 1 ? 'variable' : 'variables', value: String(vars.length) })
  const varList: Block = { kind: 'list', items: vars.map(v => ({ text: v.name, detail: truncate(v.value.replace(/\s+/g, ' '), 90) })) }
  return card('DescribePoint', {
    summary: `${fn ? `${fn}()` : 'Code'} at ${pointLabel(input) ?? 'the point'}${origin ? `, caused by ${plain(origin[1]!)}` : ''}`,
    status: 'complete',
    scope: 'point-scoped',
    facts,
    preview: [...(lines.length ? [{ kind: 'code' as const, lines: lines.slice(0, 12) }] : []), ...(vars.length ? [varList] : [])],
    sections: [
      ...(lines.length > 12 ? [{ id: 'code', title: 'Whole function', blocks: [{ kind: 'code' as const, lines }] }] : []),
      {
        id: 'consumed',
        title: 'Consumed data',
        blocks: [
          {
            kind: 'facts',
            items: [
              { label: 'point', value: pointLabel(input) ?? '?' },
              ...(time ? [{ label: 'timestamp', value: `${time[1]}ms` }] : []),
              ...(origin ? [{ label: 'origin event', value: plain(origin[1]!) }] : []),
            ],
          },
          ...vars.map(v => ({ kind: 'text' as const, text: `${v.name} = ${v.value}` })),
        ],
      },
      rawSection(text),
    ],
    actions: baseActions(input, text, [
      { kind: 'prompt', label: 'Get the call stack', text: `Use the Replay MCP GetStack tool at ${pointLabel(input) ?? 'this point'} (recording ${input.recordingId}).` },
      { kind: 'prompt', label: 'Trace the cause', text: `Use the Replay MCP DescribePoint tool with dependencyChain=true at ${pointLabel(input) ?? 'this point'} (recording ${input.recordingId}) to trace what caused it.` },
    ]),
  })
}

/** Evaluate: the expression and the value it had at the point. */
const evaluate: CardParser = (input, text) => {
  const expression = typeof input.expression === 'string' ? input.expression : '(expression)'
  const value = text.trim()
  const isError = /^(Error|Exception|Uncaught|ReferenceError|TypeError|SyntaxError)\b/.test(value)
  const isMultiline = value.includes('\n') || value.length > 120
  return card('Evaluate', {
    summary: `${truncate(expression, 60)} at ${pointLabel(input) ?? 'the point'}`,
    status: value ? (isError ? 'error' : 'complete') : 'empty',
    scope: 'point-scoped',
    facts: [{ label: 'type', value: valueType(value), tone: isError ? 'bad' : 'accent' }],
    preview: [
      { kind: 'text', text: `› ${expression}`, tone: 'muted' },
      isMultiline
        ? { kind: 'markdown', text: `\`\`\`\n${truncate(value, 1500)}\n\`\`\`` }
        : { kind: 'text', text: value || '(no value)', tone: isError ? 'bad' : 'good' },
    ],
    sections: [
      { id: 'consumed', title: 'Consumed data', blocks: [{ kind: 'facts', items: [{ label: 'point', value: pointLabel(input) ?? '?' }, { label: 'expression', value: expression }, { label: 'scope', value: String(input.scope ?? 'frame') }] }] },
      rawSection(text),
    ],
    actions: baseActions(input, text, [
      { kind: 'prompt', label: 'Evaluate another', text: `Use the Replay MCP Evaluate tool at ${pointLabel(input) ?? 'the same point'} (recording ${input.recordingId}) with the expression: ` },
    ]),
  })
}

function valueType(value: string): string {
  if (!value) return 'empty'
  if (/^".*"$/s.test(value)) return 'string'
  if (/^-?\d+(\.\d+)?$/.test(value)) return 'number'
  if (/^(true|false)$/.test(value)) return 'boolean'
  if (/^(null|undefined)$/.test(value)) return value
  if (/^\[/.test(value)) return 'array'
  if (/^\{/.test(value)) return 'object'
  if (/^(Error|\w+Error)\b/.test(value)) return 'error'
  return 'value'
}

/** GetStack: the frames from the point outwards, app code highlighted over library code. */
const getStack: CardParser = (input, text) => {
  const frames = [...text.matchAll(/^\s*(\d+)\.\s+(.+)\n\s+at\s+(.+)(?:\n\s+point:\s*(\S+))?/gm)].map(m => ({
    index: Number(m[1]),
    fn: m[2]!.trim(),
    location: m[3]!.trim(),
    point: m[4],
  }))
  if (frames.length === 0) return genericCard('GetStack', input, text, 'point-scoped')
  const appFrames = frames.filter(f => !isLibrary(f.location))
  const top = frames[0]!
  const items = frames.map(f => ({
    text: `${f.index}. ${f.fn}`,
    detail: `${shortPath(f.location)}${f.point ? `  ${f.point}` : ''}`,
    tone: (isLibrary(f.location) ? 'muted' : undefined) as Tone | undefined,
  }))
  return card('GetStack', {
    summary: `${frames.length} frame${frames.length === 1 ? '' : 's'} at ${pointLabel(input) ?? 'the point'}, innermost ${top.fn}`,
    status: 'complete',
    scope: 'point-scoped',
    facts: [
      { label: 'frames', value: String(frames.length) },
      { label: 'app frames', value: String(appFrames.length), tone: 'accent' },
      { label: 'innermost', value: fileName(top.location) },
    ],
    preview: [{ kind: 'list', items: items.slice(0, 12) }],
    sections: [
      ...(items.length > 12 ? [{ id: 'all', title: `All ${items.length} frames`, blocks: [{ kind: 'list' as const, items }] }] : []),
      rawSection(text),
    ],
    actions: baseActions(input, text, [
      { kind: 'prompt', label: `Describe ${top.fn}`, text: `Use the Replay MCP DescribePoint tool at ${top.point ?? pointLabel(input) ?? 'the innermost frame'} (recording ${input.recordingId}).` },
      ...(appFrames[0] && appFrames[0] !== top
        ? [{ kind: 'prompt' as const, label: `Describe ${appFrames[0].fn}`, text: `Use the Replay MCP DescribePoint tool at ${appFrames[0].point ?? 'its point'} (recording ${input.recordingId}).` }]
        : []),
    ]),
  })
}

/** GetPointComponent: the React component handle rendering at the point. */
const getPointComponent: CardParser = (input, text) => {
  const handle = /Component:\d+/.exec(text)?.[0]
  const name = /component\s+([A-Z][\w$.]*)/.exec(text)?.[1]
  if (!handle && !text.trim()) {
    return card('GetPointComponent', {
      summary: `No React component was rendering at ${pointLabel(input) ?? 'the point'}`,
      status: 'empty',
      scope: 'component-scoped',
      facts: [],
      preview: [{ kind: 'text', text: 'The point is outside a React render.', tone: 'muted' }],
      sections: [],
      actions: baseActions(input, text),
    })
  }
  return card('GetPointComponent', {
    summary: `${name ?? handle ?? 'A component'} was rendering at ${pointLabel(input) ?? 'the point'}`,
    status: handle || name ? 'complete' : 'partial',
    scope: 'component-scoped',
    facts: [...(handle ? [{ label: 'component', value: handle, tone: 'accent' as Tone }] : []), ...(name ? [{ label: 'name', value: name }] : [])],
    preview: [{ kind: 'text', text: truncate(plain(text.trim()), 300) }],
    sections: [rawSection(text)],
    actions: baseActions(input, text, [
      {
        kind: 'prompt',
        label: 'Show in component tree',
        text: `Use the Replay MCP ReactComponentTree tool in mode 'subtree' for ${handle ?? name ?? 'that component'} (recording ${input.recordingId}).`,
      },
    ]),
  })
}

/** GetPointLink: the app.replay.io link to the point, opened or copied. */
const getPointLink: CardParser = (input, text) => {
  const url = /https?:\/\/\S+/.exec(text)?.[0]
  if (!url) return genericCard('GetPointLink', input, text, 'point-scoped')
  const time = num(/[?&]time=([\d.]+)/.exec(url)?.[1])
  return card('GetPointLink', {
    summary: `Replay link to ${pointLabel(input) ?? 'the point'}`,
    status: 'complete',
    scope: 'point-scoped',
    facts: Number.isFinite(time) ? [{ label: 'at', value: ms(time), tone: 'info' }] : [],
    preview: [{ kind: 'text', text: truncate(url, 160), tone: 'info' }],
    sections: [],
    actions: [
      { kind: 'url', label: 'Open point in Replay', url },
      { kind: 'copy', label: 'Copy link', text: url },
    ],
  })
}

/** InspectElement: the element, its size and component, then its ancestors' boxes. */
const inspectElement: CardParser = (input, text) => {
  const [self = '', ...parents] = text.split(/\n### /)
  const tag = /Element:\d+ is `(<[^`]*?>)/.exec(self)?.[1]
  if (!tag) return genericCard('InspectElement', input, text, 'point-scoped')
  const shortTag = tag.replace(/\sclass="[^"]*"/, ' class="…"').replace(/\s(?:data-[\w-]+|id)="[^"]*"/g, '')
  const size = /has (\d+)px width and (\d+)px height/.exec(self)
  const component = /rendered by React component (\S+) at (Point:\d+)/.exec(self)
  const code = /Relevant code:\s*(\S+) line (\d+)(?: column (\d+))?/.exec(self)
  const obstructed = /No elements are obstructing/.test(self) ? 'clear' : /obstruct/i.test(self) ? 'obstructed' : undefined
  const facts: Fact[] = []
  if (size) facts.push({ label: 'size', value: `${size[1]}×${size[2]}px` })
  if (component) facts.push({ label: 'component', value: component[1]!, tone: 'accent' })
  if (obstructed) facts.push({ label: 'center', value: obstructed, tone: obstructed === 'clear' ? 'good' : 'warn' })
  const boxLines = self.split('\n').filter(l => /^(Margin|Padding|Overflow|The (width|height) is set)|^- /.test(l.trim())).map(l => l.trim())
  const ancestors = parents.map(p => {
    const t = /Element:\d+ is `(<[^\s>]+)/.exec(p)?.[1] ?? '<?'
    const c = /React component (\S+)/.exec(p)?.[1]
    const s = /has (\d+)px width and (\d+)px height/.exec(p)
    return { text: `${t}>`, detail: [c, s ? `${s[1]}×${s[2]}` : ''].filter(Boolean).join('  ') }
  })
  return card('InspectElement', {
    summary: `${/^<([\w-]+)/.exec(tag)?.[1] ?? 'element'}${component ? ` rendered by ${component[1]}` : ''}`,
    status: 'complete',
    scope: 'point-scoped',
    facts: facts.slice(0, 3),
    preview: [
      { kind: 'text', text: truncate(shortTag, 200), tone: 'info' },
      ...(code ? [{ kind: 'text' as const, text: `${shortPath(code[1]!)}:${code[2]}${code[3] ? `:${code[3]}` : ''}`, tone: 'muted' as Tone }] : []),
    ],
    sections: [
      { id: 'box', title: 'Box model', blocks: [{ kind: 'list', items: boxLines.map(l => ({ text: l.replace(/^- /, '') })) }] },
      ...(ancestors.length ? [{ id: 'ancestors', title: `Ancestors (${ancestors.length})`, blocks: [{ kind: 'list' as const, items: ancestors }] }] : []),
      { id: 'consumed', title: 'Consumed data', blocks: [{ kind: 'text', text: tag }] },
      rawSection(text),
    ],
    actions: baseActions(input, text, [
      ...(component ? [{ kind: 'prompt' as const, label: `Describe ${component[1]}`, text: `Use the Replay MCP DescribePoint tool at ${component[2]} (recording ${input.recordingId}).` }] : []),
      ...(code ? [{ kind: 'prompt' as const, label: 'Read its source', text: `Use the Replay MCP ReadSource tool on ${code[1]} line ${code[2]} (recording ${input.recordingId}).` }] : []),
    ]),
  })
}

/** Logpoint: every hit of the line with the expression's value (or error) there. */
const logpoint: CardParser = (input, text) => {
  const total = num(/Found (\d+) total hits/.exec(text)?.[1])
  const where = /hits at (\S+)/.exec(text)?.[1]
  const hits = [...text.matchAll(/Hit (\d+) at point (\S+) @ ([\d.]+)ms:\n(?:\s+Expression:.*\n)?\s+(Error|Result|Value):\s*(.*)/g)].map(m => ({
    n: Number(m[1]),
    point: m[2]!,
    time: Number(m[3]),
    isError: m[4] === 'Error',
    value: m[5]!.trim(),
  }))
  const expression = typeof input.expression === 'string' ? input.expression : '(expression)'
  const path = typeof input.path === 'string' ? input.path : where?.replace(/:\d+$/, '') ?? ''
  if (hits.length === 0 && !Number.isFinite(total)) {
    if (/no hits|0 total hits|never executed/i.test(text) || !text.trim()) {
      return card('Logpoint', {
        summary: `${fileName(path)}:${input.line ?? '?'} never ran`,
        status: 'empty',
        scope: 'source-scoped',
        facts: [{ label: 'hits', value: '0', tone: 'muted' }],
        preview: [{ kind: 'text', text: text.trim() || 'The line never executed in this recording.', tone: 'muted' }],
        sections: [rawSection(text)],
        actions: baseActions(input, text),
      })
    }
    return genericCard('Logpoint', input, text, 'source-scoped')
  }
  const errors = hits.filter(h => h.isError).length
  const allErrored = hits.length > 0 && errors === hits.length
  const items = hits.map(h => ({
    badge: `#${h.n}`,
    text: truncate(h.value, 100),
    detail: `${h.point} @ ${ms(h.time)}`,
    tone: (h.isError ? 'bad' : 'info') as Tone,
  }))
  return card('Logpoint', {
    summary: `${expression} at ${fileName(path)}:${input.line ?? '?'}`,
    status: allErrored ? 'error' : errors ? 'partial' : 'complete',
    scope: 'source-scoped',
    facts: [
      { label: 'hits', value: String(Number.isFinite(total) ? total : hits.length), tone: 'info' },
      ...(errors ? [{ label: 'errored', value: String(errors), tone: 'bad' as Tone }] : []),
      ...(hits.length ? [{ label: 'span', value: `${ms(hits[0]!.time)} – ${ms(hits[hits.length - 1]!.time)}` }] : []),
    ],
    preview: [{ kind: 'text', text: `› ${expression}`, tone: 'muted' }, { kind: 'list', items: items.slice(0, 10) }],
    sections: [
      ...(items.length > 10 ? [{ id: 'all', title: `All ${items.length} hits`, blocks: [{ kind: 'list' as const, items }] }] : []),
      {
        id: 'consumed',
        title: 'Consumed data',
        blocks: [{ kind: 'facts', items: [{ label: 'source', value: shortPath(path) }, { label: 'line', value: String(input.line ?? '?') }, { label: 'expression', value: expression }, ...(input.beginPoint ? [{ label: 'from', value: String(input.beginPoint) }] : []), ...(input.endPoint ? [{ label: 'to', value: String(input.endPoint) }] : [])] }],
      },
      rawSection(text),
    ],
    actions: baseActions(input, text, [
      ...(allErrored
        ? [{ kind: 'prompt' as const, label: 'Fix the expression', text: `Every hit of the Replay logpoint "${expression}" at ${path}:${input.line} errored (${hits[0]!.value}). Read the source around that line with ReadSource, then retry Logpoint with an expression that is in scope there (recording ${input.recordingId}).` }]
        : []),
      ...(hits[0] ? [{ kind: 'prompt' as const, label: 'Describe first hit', text: `Use the Replay MCP DescribePoint tool at ${hits[0].point} (recording ${input.recordingId}).` }] : []),
    ]),
  })
}

/** ListSources: how many sources, the app's own first, then the rest. */
const listSources: CardParser = (input, text) => {
  const count = num(/^(\d+) source\(s\) found/m.exec(text)?.[1])
  const all = text.split('\n').map(l => /^- (.+)$/.exec(l)?.[1]?.trim()).filter((s): s is string => Boolean(s))
  if (all.length === 0 && !Number.isFinite(count)) return genericCard('ListSources', input, text, 'source-scoped')
  const named = all.filter(s => !/^SOURCE\d+$/.test(s))
  const app = named.filter(s => !isLibrary(s) && /^https?:/.test(s))
  const rest = named.filter(s => !app.includes(s))
  const anonymous = all.length - named.length
  const ordered = [...app, ...rest]
  const item = (s: string) => ({ text: fileName(s), detail: shortPath(s), tone: (isLibrary(s) ? 'muted' : undefined) as Tone | undefined })
  return card('ListSources', {
    summary: `${Number.isFinite(count) ? count : all.length} sources${input.pathGlob ? ` matching ${input.pathGlob}` : ''}`,
    status: all.length ? 'complete' : 'empty',
    scope: 'source-scoped',
    facts: [
      { label: 'sources', value: String(Number.isFinite(count) ? count : all.length) },
      { label: 'app files', value: String(app.length), tone: 'accent' },
      ...(anonymous ? [{ label: 'unnamed', value: String(anonymous), tone: 'muted' as Tone }] : []),
    ],
    preview: ordered.length
      ? [{ kind: 'list', items: ordered.slice(0, 12).map(item) }]
      : [{ kind: 'text', text: `${anonymous} unnamed sources (eval'd or inline scripts) listed.`, tone: 'muted' }],
    sections: [
      ...(ordered.length > 12 ? [{ id: 'all', title: `All ${ordered.length} named sources`, blocks: [{ kind: 'list' as const, items: ordered.slice(0, 400).map(item) }] }] : []),
      rawSection(text),
    ],
    actions: baseActions(input, text, [
      ...(app[0] ? [{ kind: 'prompt' as const, label: `Read ${fileName(app[0])}`, text: `Use the Replay MCP ReadSource tool on ${app[0]} (recording ${input.recordingId}).` }] : []),
    ]),
  })
}

/** ReadSource: the lines around the requested one with how often each ran. */
const readSource: CardParser = (input, text) => {
  const lines = codeLines(text)
  if (lines.length === 0) return genericCard('ReadSource', input, text, 'source-scoped')
  const path = typeof input.path === 'string' ? input.path : ''
  const marked = lines.find(l => l.isMarked)
  const ran = lines.filter(l => l.hits && l.hits !== '0').length
  const never = lines.filter(l => l.isUnhit).length
  const preview = aroundMarked(lines, 5, 12)
  return card('ReadSource', {
    summary: `${fileName(path) || 'Source'} lines ${lines[0]!.n}–${lines[lines.length - 1]!.n}`,
    status: 'complete',
    scope: 'source-scoped',
    facts: [
      ...(marked ? [{ label: 'line', value: String(marked.n), tone: 'accent' as Tone }] : []),
      ...(marked?.hits ? [{ label: 'hits there', value: marked.hits, tone: 'info' as Tone }] : []),
      { label: 'lines ran', value: `${ran}/${lines.length}` },
      ...(never ? [{ label: 'never ran', value: String(never), tone: 'warn' as Tone }] : []),
    ].slice(0, 3),
    preview: [{ kind: 'code', path: shortPath(path), lines: preview }],
    sections: [
      ...(lines.length > preview.length ? [{ id: 'all', title: `All ${lines.length} lines`, blocks: [{ kind: 'code' as const, path: shortPath(path), lines }] }] : []),
      rawSection(text),
    ],
    actions: baseActions(input, text, [
      ...(marked
        ? [{ kind: 'prompt' as const, label: `Logpoint on line ${marked.n}`, text: `Use the Replay MCP Logpoint tool on ${path} line ${marked.n} (recording ${input.recordingId}) with an expression for the values used there.` }]
        : []),
    ]),
  })
}

/** SearchSources: matches grouped by file, each a code snippet with hit counts. */
const searchSources: CardParser = (input, text) => {
  const files = text
    .split(/^### /m)
    .slice(1)
    .map(chunk => {
      const [url = '', ...rest] = chunk.split('\n')
      return { url: url.trim(), lines: codeLines(rest.join('\n')) }
    })
    .filter(f => f.lines.length)
  if (files.length === 0) {
    if (!text.trim() || /no match/i.test(text)) {
      return card('SearchSources', {
        summary: `No matches for ${String(input.pattern ?? '')}`,
        status: 'empty',
        scope: 'source-scoped',
        facts: [],
        preview: [{ kind: 'text', text: 'Nothing in the recorded sources matched.', tone: 'muted' }],
        sections: [],
        actions: baseActions(input, text),
      })
    }
    return genericCard('SearchSources', input, text, 'source-scoped')
  }
  const matches = files.reduce((n, f) => n + f.lines.filter(l => l.isMarked).length, 0)
  // App files first, then by how many matching lines ran.
  const ranked = [...files].sort(
    (a, b) => Number(isLibrary(a.url)) - Number(isLibrary(b.url)) || b.lines.filter(l => l.isMarked && l.hits).length - a.lines.filter(l => l.isMarked && l.hits).length,
  )
  const block = (f: (typeof files)[number]): Block => ({ kind: 'code', path: shortPath(f.url), lines: f.lines.filter(l => l.isMarked).slice(0, 6) })
  return card('SearchSources', {
    summary: `"${String(input.pattern ?? '')}" in ${files.length} file${files.length === 1 ? '' : 's'}`,
    status: 'complete',
    scope: 'source-scoped',
    facts: [
      { label: 'matches', value: String(matches), tone: 'accent' },
      { label: 'files', value: String(files.length) },
      { label: 'app files', value: String(files.filter(f => !isLibrary(f.url)).length) },
    ],
    preview: ranked.slice(0, 2).map(block),
    sections: [
      ...ranked.slice(2).map((f, i) => ({ id: `f${i}`, title: fileName(f.url), blocks: [{ kind: 'code' as const, path: shortPath(f.url), lines: f.lines }] })),
      { id: 'consumed', title: 'Consumed data', blocks: [{ kind: 'facts', items: [{ label: 'pattern', value: String(input.pattern ?? '') }, ...(input.pathGlob ? [{ label: 'path glob', value: String(input.pathGlob) }] : [])] }] },
      rawSection(text),
    ],
    actions: baseActions(input, text, [
      ...(ranked[0]
        ? [{ kind: 'prompt' as const, label: `Read ${fileName(ranked[0].url)}`, text: `Use the Replay MCP ReadSource tool on ${ranked[0].url} line ${ranked[0].lines.find(l => l.isMarked)?.n ?? 1} (recording ${input.recordingId}).` }]
        : []),
    ]),
  })
}

/** ExecutionDelay: how long after the source loaded each part of it first ran. */
const executionDelay: CardParser = (input, text) => {
  const buckets = [...text.matchAll(/^(\d+-\d+ms|Never executed):\s*([\d.]+)%\s*\((\d+) chars\)/gm)].map(m => ({
    label: m[1]!,
    pct: Number(m[2]),
    chars: Number(m[3]),
  }))
  const fns = [...text.matchAll(/^(\S.*?) \[(\d+:\d+-\d+:\d+)\]: length=(\d+), weight=(\d+), first breakpoint delay=(never executed|[\d.]+ms)/gm)].map(m => ({
    name: m[1]!,
    range: m[2]!,
    length: m[3]!,
    weight: m[4]!,
    delay: m[5]!,
  }))
  if (buckets.length === 0 && fns.length === 0) return genericCard('ExecutionDelay', input, text, 'source-scoped')
  const loaded = /Source downloaded at ([\d.]+)ms/.exec(text)?.[1]
  const path = typeof input.path === 'string' ? input.path : /analysis for (\S+)/.exec(text)?.[1] ?? ''
  const never = buckets.find(b => /never/i.test(b.label))
  // Buckets are 100ms wide, so keep a tenth of a second on long delays.
  const label = (l: string) => {
    const m = /^(\d+)-\d+ms$/.exec(l)
    if (!m) return l
    const at = Number(m[1])
    return at >= 1000 ? `+${(at / 1000).toFixed(1)}s` : `+${at}ms`
  }
  return card('ExecutionDelay', {
    summary: `When ${fileName(path)} first ran, by share of its code`,
    status: 'complete',
    scope: 'source-scoped',
    facts: [
      ...(loaded ? [{ label: 'loaded at', value: ms(Number(loaded)), tone: 'info' as Tone }] : []),
      { label: 'functions', value: String(fns.length || num(/Total functions: (\d+)/.exec(text)?.[1])) },
      ...(never ? [{ label: 'never ran', value: `${never.pct}%`, tone: 'warn' as Tone }] : []),
    ],
    preview: [
      {
        kind: 'bars',
        items: buckets.slice(0, 12).map(b => ({ label: label(b.label), value: b.pct, display: `${b.pct}%`, tone: (/never/i.test(b.label) ? 'warn' : 'accent') as Tone })),
      },
    ],
    sections: [
      {
        id: 'functions',
        title: `Functions (${fns.length})`,
        blocks: [
          {
            kind: 'table',
            columns: ['function', 'range', 'weight', 'first ran after'],
            rows: fns.map(f => [f.name, f.range, f.weight, f.delay === 'never executed' ? 'never' : ms(num(f.delay))]),
            numeric: [false, false, true, true],
            tones: fns.map(f => (f.delay === 'never executed' ? 'muted' : undefined)),
          },
        ],
      },
      rawSection(text),
    ],
    actions: baseActions(input, text, [
      { kind: 'prompt', label: 'Read the slow parts', text: `Use the Replay MCP ReadSource tool on ${path} at the functions that ran last or never ran (recording ${input.recordingId}), and explain why they were delayed.` },
    ]),
  })
}

export const CODE_PARSERS: Record<string, CardParser> = {
  DescribePoint: describePoint,
  Evaluate: evaluate,
  GetStack: getStack,
  GetPointComponent: getPointComponent,
  GetPointLink: getPointLink,
  InspectElement: inspectElement,
  Logpoint: logpoint,
  ListSources: listSources,
  ReadSource: readSource,
  SearchSources: searchSources,
  ExecutionDelay: executionDelay,
}
