// Keep ordered actions, but never make a click wait behind obsolete pointer positions.
export function createDashboardQueue({ sendInput, resize, onError = () => {} }) {
  const pending = []
  const seen = new Map()
  let running = null
  let closed = false
  const isMove = entry => entry?.input?.type === 'pointer' && entry.input.event === 'move'
  const append = entry => {
    const tail = pending.at(-1)
    if (isMove(entry) && isMove(tail) && tail.stream === entry.stream && tail.input.button === entry.input.button) pending[pending.length - 1] = entry
    else if (entry.kind === 'resize' && tail?.kind === 'resize') pending[pending.length - 1] = entry
    else if (entry.input?.type === 'wheel' && tail?.input?.type === 'wheel' && Math.abs(tail.input.deltaY + entry.input.deltaY) <= 1000) {
      tail.input = { ...entry.input, deltaY: tail.input.deltaY + entry.input.deltaY }
    } else pending.push(entry)
  }
  const drain = () => {
    if (running || closed) return
    running = (async () => {
      while (pending.length && !closed) {
        const first = pending.shift()
        let input = first.input
        if (first.stream) {
          const events = [{ seq: first.seq, input }]
          while (events.length < 128 && pending[0]?.stream === first.stream) {
            const next = pending.shift()
            events.push({ seq: next.seq, input: next.input })
          }
          input = { type: 'batch', stream: first.stream, events }
        }
        // Retries carry sequence numbers, so the relay can discard already-applied actions.
        for (let attempt = 0; ; attempt++) {
          try {
            if (first.kind === 'resize') await resize(first.view)
            else await sendInput(input)
            break
          } catch (error) {
            if (!closed && input?.type === 'batch' && attempt === 0) continue
            onError(error, first.kind)
            break
          }
        }
      }
    })().finally(() => { running = null; if (pending.length && !closed) drain() })
  }
  return {
    push(input) {
      if (closed) return
      if (input.type === 'batch') {
        if (typeof input.stream !== 'string' || input.stream.length > 100 || !Array.isArray(input.events) || input.events.length > 128) return
        for (const event of input.events ?? []) {
          if (!Number.isSafeInteger(event.seq) || event.seq <= (seen.get(input.stream) ?? 0)) continue
          seen.set(input.stream, event.seq)
          append({ kind: 'input', stream: input.stream, seq: event.seq, input: event.input })
        }
        if (seen.size > 16) seen.delete(seen.keys().next().value)
      } else append({ kind: 'input', input })
      drain()
    },
    resize(view) { if (!closed) { append({ kind: 'resize', view }); drain() } },
    async idle() { while (running) await running },
    close() { closed = true; pending.length = 0; seen.clear() },
  }
}
