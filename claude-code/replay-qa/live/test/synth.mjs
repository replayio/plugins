// Minimal valid rrweb event streams for tests: a page with a heading, a status line and a
// counter that changes every step, so a live player visibly moves.

let nextId = 1

/** A FullSnapshot document: <html><body><h1/><p id=status/><p id=count/></body></html>. */
function snapshot(title, ts, width, height) {
  const ids = { doc: 1, html: 2, body: 3, h1: 4, h1t: 5, status: 6, statusT: 7, count: 8, countT: 9 }
  nextId = 10
  const el = (id, tagName, attributes, childNodes) => ({ type: 2, tagName, attributes, childNodes, id })
  const text = (id, textContent) => ({ type: 3, textContent, id })
  return {
    ids,
    events: [
      { type: 4, data: { href: 'http://localhost:3000/', width, height }, timestamp: ts },
      {
        type: 2,
        data: {
          node: {
            type: 0,
            id: ids.doc,
            childNodes: [
              { type: 1, name: 'html', publicId: '', systemId: '', id: 10 },
              el(ids.html, 'html', {}, [
                el(ids.body, 'body', { style: 'font-family:sans-serif;margin:24px;background:#f6f7fb' }, [
                  el(ids.h1, 'h1', { style: 'font-size:28px;margin:0 0 12px' }, [text(ids.h1t, title)]),
                  el(ids.status, 'p', { style: 'color:#555' }, [text(ids.statusT, 'Starting…')]),
                  el(ids.count, 'p', { style: 'font-size:56px;font-weight:700;color:#F02D5E' }, [text(ids.countT, '0')]),
                ]),
              ]),
            ],
          },
          initialOffset: { left: 0, top: 0 },
        },
        timestamp: ts + 1,
      },
    ],
  }
}

/**
 * `steps` rrweb events for a page titled `title`, starting at `startTs`, one step per
 * `stepMs`: a Meta, a FullSnapshot, then text mutations that count up.
 * A `bigBytes` filler makes the snapshot large enough to exercise chunking and 502s.
 */
export function synthEvents({ title = 'Journey', steps = 20, startTs = 1_700_000_000_000, stepMs = 500, width = 1280, height = 720, bigBytes = 0 } = {}) {
  const { ids, events } = snapshot(title, startTs, width, height)
  if (bigBytes) {
    // A large inline <style> in <head>-less position: valid enough for rrweb and heavy on the wire.
    const body = events[1].data.node.childNodes[1].childNodes[0]
    body.childNodes.push({ type: 2, tagName: 'style', attributes: { _cssText: '/*' + 'x'.repeat(bigBytes) + '*/' }, childNodes: [], id: 100 })
  }
  for (let i = 1; i <= steps; i++) {
    const ts = startTs + 2 + i * stepMs
    events.push({
      type: 3,
      data: { source: 0, texts: [{ id: ids.countT, value: String(i) }, { id: ids.statusT, value: `Step ${i} of ${steps}` }], attributes: [], removes: [], adds: [] },
      timestamp: ts,
    })
  }
  return events
}
