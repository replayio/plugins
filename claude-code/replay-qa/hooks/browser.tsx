/* @jsx h */
import type { ClientKeyEvent, ClientPointerEvent, ClientSurface } from 'claude-code'

type Local = { stream: string; seq: number; events: { seq: number; input: Record<string, unknown> }[] }
const locals = new WeakMap<object, Local>()

// A transparent input surface over the browser picture. The dashboard owns all UI behavior.
export default function Dashboard(_props: unknown, surface: ClientSurface) {
  const { Box } = surface.elements
  let local = locals.get(surface)
  if (!local) {
    local = { stream: `${Date.now()}-${Math.random()}`, seq: 0, events: [] }
    locals.set(surface, local)
  }
  const state = local
  // Client posts coalesce within a frame. Keep a short sequence so a quick down/up or typing burst
  // survives that coalescing; the browser discards events it has already dispatched.
  const post = (input: Record<string, unknown>) => {
    state.events.push({ seq: ++state.seq, input })
    state.events = state.events.slice(-128)
    surface.post({ type: 'batch', stream: state.stream, events: [...state.events] })
  }
  surface.onPointer((e: ClientPointerEvent) => {
    post({
      type: 'pointer', event: e.type, button: e.button,
      x: (e.fine?.x ?? e.x + 0.5) / Math.max(1, surface.columns),
      y: (e.fine?.y ?? e.y + 0.5) / Math.max(1, surface.rows),
    })
  })
  surface.onKey((e: ClientKeyEvent) => post({ type: 'key', key: e.key }))
  return <Box width={surface.columns} height={surface.rows} />
}
