// At most one asynchronous frame write. Under load, publish the newest pending picture.
export function createFramePump({ fps, write, onError = () => {} }) {
  let pending = null
  let writing = null
  let timer = null
  let lastStart = -Infinity
  let closed = false
  const pump = () => {
    if (closed || writing || timer || pending === null) return
    const wait = Math.max(0, 1000 / fps - (performance.now() - lastStart))
    if (wait > 0) { timer = setTimeout(() => { timer = null; pump() }, wait); return }
    const frame = pending
    pending = null
    lastStart = performance.now()
    writing = Promise.resolve().then(() => write(frame, () => !closed))
      .catch(onError).finally(() => { writing = null; pump() })
  }
  return {
    push(frame) { if (!closed) { pending = frame; pump() } },
    async close() { closed = true; pending = null; clearTimeout(timer); timer = null; await writing },
  }
}
