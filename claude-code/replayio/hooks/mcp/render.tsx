/* @jsx h */
import type { EngineInterface, Register } from 'claude-code'

import { errorCard, truncate, type Block, type Card, type Status, type Tone, type ToolInput } from './card.ts'
import { cardFor, replayToolName, resultText } from './cards.ts'

// Draws each Replay MCP tool call as a card in place of its transcript row.
// The card is built from the markdown the model read (no second call to the
// server), so what the person sees is exactly the evidence Claude used.

type On = Parameters<Register>[0]

/** A local PNG the terminal can draw for a remote image (the relay converts JPEGs), with its size. */
export type LocalImage = { file: string; width: number; height: number }

/** The relay's address for image conversion (`http://127.0.0.1:<port>`, `token`), or null while it is down. */
export type RelayAddress = () => { base: string; token: string } | null

async function fetchImage($: EngineInterface, relay: { base: string; token: string }, url: string): Promise<LocalImage | null> {
  try {
    const res = await $.http.fetch(`${relay.base}/image?url=${encodeURIComponent(url)}&token=${relay.token}`)
    return res.ok ? (JSON.parse(res.text) as LocalImage) : null
  } catch {
    return null
  }
}

const ACCENT = '#a78bfa'
const TONES: Record<Tone, string> = {
  accent: ACCENT,
  good: '#4ade80',
  bad: '#f87171',
  warn: '#fbbf24',
  info: '#60a5fa',
  muted: '#8b8b98',
}
const STATUS_TONE: Record<Status, Tone> = { complete: 'good', partial: 'warn', empty: 'muted', error: 'bad', running: 'info' }
const ROW_HOVER = '#2b2540'

function inputSummary(input: ToolInput): string {
  return Object.entries(input)
    .filter(([k, v]) => k !== 'recordingId' && v !== undefined && v !== '')
    .map(([k, v]) => `${k}=${typeof v === 'string' ? truncate(v, 40) : JSON.stringify(v)}`)
    .join(' ')
}

const state = {
  /** tool_use_id -> ids of the sections the person opened */
  open: new Map<string, Set<string>>(),
  /** remote image url -> local PNG (null while resolving or when it failed) */
  images: new Map<string, LocalImage | null>(),
}

export function registerMcpCards(on: On, relayAddress: RelayAddress): void {
  // Runs of read-only calls fold into one count line; unfold the ones that hold Replay cards.
  on('ui.render', { component: 'ToolGroup' }, ($, e, next) =>
    e.props.calls.some(c => replayToolName(c.tool)) && !e.props.isExpanded
      ? next({ ...e, props: { ...e.props, isExpanded: true } })
      : next(e))

  // The card replaces the call's row; its result block below would repeat it.
  on('ui.render', { component: 'ToolResult' }, ($, e, next) => {
    if (!replayToolName(e.props.tool)) return next(e)
    const { Box } = $.ui.resolve(e)
    return <Box />
  })

  on('ui.render', { component: 'ToolUse' }, async ($, e, next) => {
    const tool = replayToolName(e.props.tool)
    if (!tool) return next(e)
    const id = e.requestId
    const input = (e.props.input ?? {}) as ToolInput
    const width = Math.max(40, Math.min(140, (e.viewport?.columns ?? 100) - 4))
    const card: Card = e.props.isRunning
      ? { tool, title: tool, summary: inputSummary(input) || 'Querying the recording…', status: 'running', scope: 'recording-wide', facts: [], preview: [], sections: [], actions: [] }
      : e.props.isInterrupted
        ? { ...errorCard(tool, input, 'Interrupted'), summary: 'Interrupted' }
        : cardFor(tool, input, resultText(e.props.output), e.props.isErrored)

    const ui = $.ui.resolve(e)
    const { Box, Text, Button, Markdown } = ui
    const open = state.open.get(id) ?? new Set<string>()
    const inner = width - 4

    const toggle = (section: string) => {
      const set = new Set(state.open.get(id) ?? [])
      set.has(section) ? set.delete(section) : set.add(section)
      state.open.set(id, set)
      $.ui.invalidate('ui.render')
    }

    const tone = (t?: Tone) => (t ? TONES[t] : undefined)

    const drawBlock = (block: Block, key: string) => {
      switch (block.kind) {
        case 'text':
          return <Text key={key} color={tone(block.tone)} wrap="wrap">{block.text}</Text>
        case 'markdown':
          return <Markdown key={key} text={block.text} />
        case 'facts':
          return (
            <Box key={key} flexDirection="column">
              {block.items.map((f, i) => (
                <Box key={`${key}-${i}`} flexDirection="row" gap={1}>
                  <Text dimColor>{f.label}</Text>
                  <Text color={tone(f.tone)} wrap="truncate-end">{f.value}</Text>
                </Box>
              ))}
            </Box>
          )
        case 'list':
          return (
            <Box key={key} flexDirection="column">
              {block.items.map((item, i) => (
                <Box key={`${key}-${i}`} flexDirection="row" gap={1} hover={{ backgroundColor: ROW_HOVER }}>
                  {item.badge ? <Text color={tone(item.tone)} bold>{item.badge}</Text> : <Text color={tone(item.tone) ?? ACCENT}>•</Text>}
                  <Text color={item.badge ? undefined : tone(item.tone)} wrap="truncate-end">{item.text}</Text>
                  {item.detail ? <Text dimColor wrap="truncate-end">{item.detail}</Text> : null}
                </Box>
              ))}
            </Box>
          )
        case 'table': {
          const cols = block.columns.length
          const natural = block.columns.map((c, ci) => Math.max(c.length, ...block.rows.map(r => (r[ci] ?? '').length)))
          // Shrink the widest columns until the row fits.
          const widths = [...natural]
          while (widths.reduce((a, b) => a + b, 0) + (cols - 1) * 2 > inner && Math.max(...widths) > 6) {
            const wi = widths.indexOf(Math.max(...widths))
            widths[wi] = widths[wi]! - 1
          }
          const cell = (s: string, ci: number) => {
            const w = widths[ci]!
            const t = truncate(s, w)
            return block.numeric?.[ci] ? t.padStart(w) : t.padEnd(w)
          }
          return (
            <Box key={key} flexDirection="column">
              <Text dimColor bold>{block.columns.map(cell).join('  ')}</Text>
              {block.rows.map((r, ri) => (
                <Box key={`${key}-${ri}`} hover={{ backgroundColor: ROW_HOVER }}>
                  <Text color={tone(block.tones?.[ri])}>{block.columns.map((_, ci) => cell(r[ci] ?? '', ci)).join('  ')}</Text>
                </Box>
              ))}
            </Box>
          )
        }
        case 'code': {
          const nw = Math.max(2, ...block.lines.map(l => String(l.n ?? '').length))
          const hw = Math.max(1, ...block.lines.map(l => (l.hits ?? '').length))
          return (
            <Box key={key} flexDirection="column">
              {block.path ? <Text dimColor wrap="truncate-start">{block.path}</Text> : null}
              {block.lines.map((l, li) => (
                <Box key={`${key}-${li}`} flexDirection="row" hover={{ backgroundColor: ROW_HOVER }}>
                  <Text color={l.hits && l.hits !== '0' ? TONES.info : TONES.muted}>{(l.hits ?? '').padStart(hw)} </Text>
                  <Text dimColor>{String(l.n ?? '').padStart(nw)} </Text>
                  <Text color={l.isMarked ? ACCENT : undefined} bold={l.isMarked} dimColor={l.isUnhit} wrap="truncate-end">
                    {l.isMarked ? '▶ ' : '  '}{l.text}
                  </Text>
                </Box>
              ))}
            </Box>
          )
        }
        case 'bars': {
          const max = Math.max(...block.items.map(b => b.value), 1)
          const lw = Math.min(28, Math.max(...block.items.map(b => b.label.length)))
          const dw = Math.max(...block.items.map(b => b.display.length))
          const bw = Math.max(6, inner - lw - dw - 3)
          return (
            <Box key={key} flexDirection="column">
              {block.items.map((b, bi) => {
                const len = Math.max(b.value > 0 ? 1 : 0, Math.round((b.value / max) * bw))
                return (
                  <Box key={`${key}-${bi}`} flexDirection="row" hover={{ backgroundColor: ROW_HOVER }}>
                    <Text>{truncate(b.label, lw).padEnd(lw)} </Text>
                    <Text color={tone(b.tone) ?? ACCENT}>{'█'.repeat(len)}</Text>
                    <Text dimColor>{'·'.repeat(Math.max(0, bw - len))} {b.display.padStart(dw)}</Text>
                  </Box>
                )
              })}
            </Box>
          )
        }
        case 'tree':
          return (
            <Box key={key} flexDirection="column">
              {block.lines.map((l, li) => (
                <Box key={`${key}-${li}`} flexDirection="row" hover={{ backgroundColor: ROW_HOVER }}>
                  <Text>{'  '.repeat(l.depth)}</Text>
                  <Text color={ACCENT}>{l.isOpen === undefined ? '  ' : l.isOpen ? '▼ ' : '▶ '}</Text>
                  <Text wrap="truncate-end">{l.text}</Text>
                  {l.detail ? <Text dimColor> {l.detail}</Text> : null}
                </Box>
              ))}
            </Box>
          )
        case 'image': {
          const image = state.images.get(block.url)
          const relay = relayAddress()
          if (image === undefined && relay) {
            state.images.set(block.url, null)
            void fetchImage($, relay, block.url).then(found => {
              state.images.set(block.url, found)
              if (found) $.ui.invalidate('ui.render')
            })
          }
          if (image && e.surface === 'terminal') {
            const { Image } = $.ui.resolve(e)
            const columns = Math.min(inner, 90)
            // A cell is about twice as tall as wide; keep the picture's aspect.
            const rows = Math.max(4, Math.min(40, Math.round((columns * image.height) / image.width / 2.1)))
            return (
              <Box key={key} flexDirection="column">
                <Image key={`${key}-img`} source={{ file: image.file, format: 'png' }} columns={columns} rows={rows} alt={block.caption ?? 'Screenshot'} />
                {block.caption ? <Text dimColor>{block.caption}</Text> : null}
              </Box>
            )
          }
          return <Text key={key} dimColor>{block.caption ?? 'Screenshot'}: {block.url}</Text>
        }
      }
    }

    const runAction = async (i: number, surface: typeof e.surface) => {
      const action = card.actions[i]
      if (!action) return
      if (action.kind === 'url') await $.process.run(['open', action.url]).catch(() => $.ui.toast(action.url))
      else if (action.kind === 'prompt') await $.prompt.fill({ text: action.text })
      else {
        const copied = await $.ui.copy({ text: action.text, surface })
        $.ui.toast(copied.isCopied ? 'Copied' : 'Could not copy here')
      }
    }

    const statusTone = TONES[STATUS_TONE[card.status]]
    return (
      <Box flexDirection="column" borderStyle="round" borderColor={card.status === 'error' ? TONES.bad : ACCENT} paddingX={1} width={width}>
        <Box flexDirection="row" justifyContent="space-between">
          <Box flexDirection="row" gap={1} flexShrink={1}>
            <Text color={ACCENT} bold>◆ {card.title}</Text>
            <Text dimColor wrap="truncate-end">{card.summary}</Text>
          </Box>
          <Box flexDirection="row" gap={1} flexShrink={0}>
            <Text color={statusTone}>{card.status === 'running' ? '◌ running' : card.status}</Text>
            <Text dimColor>· {card.scope}</Text>
          </Box>
        </Box>
        {card.facts.length ? (
          <Box flexDirection="row" gap={2} flexWrap="wrap">
            {card.facts.map((f, i) => (
              <Box key={`fact-${i}`} flexDirection="row" gap={1}>
                <Text bold color={tone(f.tone)}>{f.value}</Text>
                <Text dimColor>{f.label}</Text>
              </Box>
            ))}
          </Box>
        ) : null}
        {card.preview.map((b, i) => drawBlock(b, `preview-${i}`))}
        {card.sections.length ? (
          <Box flexDirection="row" gap={1} flexWrap="wrap">
            {card.sections.map(s => (
              <Button key={`sec-${s.id}`} plain label={`${open.has(s.id) ? '▾' : '▸'} ${s.title}`} onPress={() => toggle(s.id)} />
            ))}
          </Box>
        ) : null}
        {card.sections.filter(s => open.has(s.id)).map(s => (
          <Box key={`open-${s.id}`} flexDirection="column" borderStyle="single" borderColor={TONES.muted} borderDimColor paddingX={1}>
            <Text color={ACCENT}>{s.title}</Text>
            {s.blocks.map((b, i) => drawBlock(b, `${s.id}-${i}`))}
          </Box>
        ))}
        {card.actions.length ? (
          <Box flexDirection="row" gap={1} flexWrap="wrap">
            {card.actions.map((a, i) => (
              <Button key={`act-${i}`} label={a.label} variant={i === 0 ? 'primary' : undefined} onPress={press => void runAction(i, press.surface)} />
            ))}
          </Box>
        ) : null}
      </Box>
    )
  })
}
