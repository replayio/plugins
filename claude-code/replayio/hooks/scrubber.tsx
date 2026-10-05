/* @jsx h */
import type { ClientKeyEvent, ClientPointerEvent, ClientSurface } from 'claude-code'

// The player's seek bar, drawn in the terminal and driven by the pointer:
// click or drag anywhere on the bar to seek, Space toggles play, ←/→ step 5s.
// Between the plugin's redraws it advances the playhead on its own clock, so
// steady playback costs no redraw of the transcript.

export type ScrubberProps = {
  currentMs: number
  totalMs: number
  /** Whether the playhead is moving: `currentMs` was true at `at`. */
  isPlaying: boolean
  at: number
  isLive: boolean
}

type State = { tick: number; dragRatio: number | null }

/** Each instance's newest props, for its timer, which outlives a render. */
const latest = new WeakMap<object, ScrubberProps>()

const clock = (ms: number) => {
  const s = Math.max(0, Math.round(ms / 1000))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

export default function Scrubber(raw: unknown, surface: ClientSurface<State>) {
  const { Box, Text } = surface.elements
  const props = raw as ScrubberProps
  latest.set(surface, props)

  const now = () => {
    const moved = props.isPlaying ? Date.now() - props.at : 0
    return Math.max(0, Math.min(props.totalMs, props.currentMs + moved))
  }
  const totalLabel = ` ${clock(props.totalMs)}`
  const leftWidth = 6
  const barWidth = Math.max(4, surface.columns - leftWidth - totalLabel.length)
  const ratioAt = (x: number) => Math.max(0, Math.min(1, (x - leftWidth) / Math.max(1, barWidth - 1)))

  if (surface.state === undefined) {
    surface.setState({ tick: 0, dragRatio: null })
    surface.every(250, () => {
      const s = surface.state
      if (s && latest.get(surface)?.isPlaying) surface.setState({ ...s, tick: s.tick + 1 })
    })
  }
  surface.onPointer((event: ClientPointerEvent) => {
    const s = surface.state
    if (!s || props.isLive || props.totalMs <= 0) return
    if (event.type === 'down') surface.setState({ ...s, dragRatio: ratioAt(event.x) })
    else if (event.type === 'move' && s.dragRatio !== null) surface.setState({ ...s, dragRatio: ratioAt(event.x) })
    else if (event.type === 'up' && s.dragRatio !== null) {
      surface.post({ type: 'seek', ms: Math.round(ratioAt(event.x) * props.totalMs) })
      surface.setState({ ...s, dragRatio: null })
    } else if (event.type === 'leave' && s.dragRatio !== null) surface.setState({ ...s, dragRatio: null })
  })
  surface.onKey((event: ClientKeyEvent) => {
    if (props.isLive) return
    if (event.key === ' ' || event.key === 'space') surface.post({ type: 'toggle' })
    else if (event.key === 'left') surface.post({ type: 'seekBy', ms: -5000 })
    else if (event.key === 'right') surface.post({ type: 'seekBy', ms: 5000 })
  })

  if (props.isLive) {
    return (
      <Box flexDirection="row">
        <Text color="red">● LIVE </Text>
        <Text dimColor>scrub once the browser closes, or press ▶ Replay to scrub what is recorded so far</Text>
      </Box>
    )
  }

  const ratio = surface.state?.dragRatio ?? (props.totalMs > 0 ? now() / props.totalMs : 0)
  const head = Math.round(ratio * (barWidth - 1))
  const shown = surface.state?.dragRatio != null ? ratio * props.totalMs : now()
  return (
    <Box flexDirection="row">
      <Text>{clock(shown).padStart(leftWidth - 1)} </Text>
      <Text color="red">{'━'.repeat(head)}</Text>
      <Text bold>●</Text>
      <Text dimColor>{'─'.repeat(Math.max(0, barWidth - head - 1))}</Text>
      <Text dimColor>{totalLabel}</Text>
    </Box>
  )
}
