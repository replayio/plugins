/* @jsx h */
import type { ClientKeyEvent, ClientPointerEvent, ClientSurface } from 'claude-code'

// Laid over the canvas picture in the pane, it turns the pointer and keys into camera moves for
// the hooks module, which hands them to the relay's screencast: drag to pan, double-click a tile
// to focus it (the background to fit), and once clicked + − 0 1 and the arrows. The wheel zooms
// through the pane's ui.scroll instead, as a Client gets no wheel.
//
// Points and distances are posted as fractions of the picture, so nothing here knows pixels.

/** A drag posts its total from where it began: a post replaced within a frame loses nothing. */
type Drag = { id: number; x: number; y: number; moved: boolean }
type Local = { drag: Drag | null; lastClick: { at: number; x: number; y: number } | null; drags: number }

/** Each instance's pointer state, kept off `surface.state` so moving the pointer redraws nothing. */
const locals = new WeakMap<object, Local>()

const DOUBLE_CLICK_MS = 400

export default function Camera(_props: unknown, surface: ClientSurface) {
  const { Box } = surface.elements
  let local = locals.get(surface)
  if (!local) locals.set(surface, (local = { drag: null, lastClick: null, drags: 0 }))
  const l = local

  const at = (e: ClientPointerEvent) => ({ x: e.fine?.x ?? e.x + 0.5, y: e.fine?.y ?? e.y + 0.5 })
  const columns = () => Math.max(1, surface.columns)
  const rows = () => Math.max(1, surface.rows)

  surface.onPointer((e: ClientPointerEvent) => {
    const p = at(e)
    if (e.type === 'down' && e.button === 'left') {
      l.drag = { id: ++l.drags, x: p.x, y: p.y, moved: false }
    } else if (e.type === 'move' && l.drag && e.button) {
      const dx = p.x - l.drag.x
      const dy = p.y - l.drag.y
      if (Math.abs(dx) + Math.abs(dy) >= 0.5) l.drag.moved = true
      if (l.drag.moved) surface.post({ type: 'drag', id: l.drag.id, dx: dx / columns(), dy: dy / rows() })
    } else if (e.type === 'up' && l.drag) {
      const drag = l.drag
      l.drag = null
      if (drag.moved) {
        surface.post({ type: 'drag', id: drag.id, dx: (p.x - drag.x) / columns(), dy: (p.y - drag.y) / rows() })
        return
      }
      const now = Date.now()
      const last = l.lastClick
      if (last && now - last.at < DOUBLE_CLICK_MS && Math.abs(last.x - p.x) < 2 && Math.abs(last.y - p.y) < 1) {
        l.lastClick = null
        surface.post({ type: 'focus', x: p.x / columns(), y: p.y / rows() })
      } else {
        l.lastClick = { at: now, x: p.x, y: p.y }
      }
    }
  })

  surface.onKey((e: ClientKeyEvent) => {
    if (e.key === '+' || e.key === '=') surface.post({ type: 'zoom', factor: 1.25 })
    else if (e.key === '-' || e.key === '_') surface.post({ type: 'zoom', factor: 0.8 })
    else if (e.key === '0') surface.post({ type: 'fit' })
    else if (e.key === '1') surface.post({ type: 'actual' })
    else if (e.key === 'left') surface.post({ type: 'pan', dx: 0.1, dy: 0 })
    else if (e.key === 'right') surface.post({ type: 'pan', dx: -0.1, dy: 0 })
    else if (e.key === 'up') surface.post({ type: 'pan', dx: 0, dy: 0.1 })
    else if (e.key === 'down') surface.post({ type: 'pan', dx: 0, dy: -0.1 })
  })

  return <Box width={surface.columns} height={surface.rows} />
}
