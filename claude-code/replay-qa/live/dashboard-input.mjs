// Input coordinates are fractions of the displayed viewport, independent of terminal cells.
const fraction = value => Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0.5
const keys = { enter: 'Enter', escape: 'Escape', backspace: 'Backspace', delete: 'Delete', tab: 'Tab', left: 'ArrowLeft', right: 'ArrowRight', up: 'ArrowUp', down: 'ArrowDown', home: 'Home', end: 'End', pageup: 'PageUp', pagedown: 'PageDown', space: ' ' }

export async function dispatchDashboardInput(send, frame, input, streams = new Map()) {
  if (input.type === 'batch') {
    if (typeof input.stream !== 'string' || input.stream.length > 100 || !Array.isArray(input.events) || input.events.length > 128) throw new Error('invalid input batch')
    for (const event of input.events) {
      if (!Number.isSafeInteger(event.seq) || event.seq <= (streams.get(input.stream) ?? 0)) continue
      if (!event.input || event.input.type === 'batch') throw new Error('invalid input event')
      await dispatchDashboardInput(send, frame, event.input)
      streams.set(input.stream, event.seq)
    }
    if (streams.size > 16) streams.delete(streams.keys().next().value)
    return
  }
  const x = fraction(input.x) * Math.max(0, frame.width - 1)
  const y = fraction(input.y) * Math.max(0, frame.height - 1)
  if (input.type === 'pointer') {
    const type = { down: 'mousePressed', up: 'mouseReleased', move: 'mouseMoved' }[input.event]
    if (!type) throw new Error('unknown pointer event')
    const button = ['left', 'right', 'middle'].includes(input.button) ? input.button : 'none'
    await send('Input.dispatchMouseEvent', { type, x, y, button, buttons: input.event === 'up' ? 0 : button === 'left' ? 1 : button === 'right' ? 2 : button === 'middle' ? 4 : 0, clickCount: type === 'mouseMoved' ? 0 : 1 })
  } else if (input.type === 'wheel') {
    const deltaY = Number.isFinite(input.deltaY) ? Math.max(-1000, Math.min(1000, input.deltaY)) : 0
    await send('Input.dispatchMouseEvent', { type: 'mouseWheel', x, y, deltaX: 0, deltaY })
  } else if (input.type === 'key') {
    if (typeof input.key !== 'string' || input.key.length > 32) throw new Error('invalid key')
    const key = keys[input.key.toLowerCase()] ?? input.key
    if (key.length === 1) await send('Input.insertText', { text: key })
    else {
      await send('Input.dispatchKeyEvent', { type: 'keyDown', key })
      await send('Input.dispatchKeyEvent', { type: 'keyUp', key })
    }
  } else throw new Error('unknown dashboard input')
}
