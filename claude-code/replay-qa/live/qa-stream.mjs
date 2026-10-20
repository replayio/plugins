// Reads a Replay QA recording as rows, page by page, from
//   GET /api/v1/projects/{project_id}/recording-events?<task_id|test_run_id|exploration_id|recording_id>=…
//
// What the API makes necessary (found against the live service):
//  - A page that is too big answers 502 `Function.ResponseSizeTooLarge` (6 MB cap): rrweb full
//    snapshots are huge, so the page size starts small and halves on that error.
//  - An rrweb event too large for one row arrives as `rrweb-chunk` rows
//    `{ chunk_id, index, total, data }` that may span pages: they are joined back into one event.
//  - `next_cursor` is `{ after_task_id, after_seq }`; null means "nothing more right now". A
//    running recording is followed by asking again from the last row seen.
//
// Pure: `request(pathAndQuery)` is injected, so tests run it against a mock.

export class AuthError extends Error {}
export class NotFoundError extends Error {}

const TOO_LARGE = /ResponseSizeTooLarge|payload size exceeded/i

/**
 * @typedef {{ kind: 'rrweb', event: any, taskId: string, seq: number }
 *   | { kind: 'note', type: 'thought'|'note'|'error'|'system', text: string, ts: number, step?: { index: number, action: string }, taskId: string, seq: number }} Row
 */

export class RecordingStream {
  /**
   * @param {object} o
   * @param {(path: string) => Promise<{ status: number, data: any }>} o.request
   * @param {string} o.projectId
   * @param {'task_id'|'test_run_id'|'exploration_id'|'recording_id'} o.key
   * @param {string} o.id
   * @param {number} [o.firstLimit]
   */
  constructor({ request, projectId, key, id, firstLimit = 20 }) {
    this.request = request
    this.projectId = projectId
    this.key = key
    this.id = id
    this.maxLimit = firstLimit
    this.limit = firstLimit
    /** `{ after_task_id, after_seq }` to continue from: the server's next cursor, else the last row. */
    this.cursor = null
    /** chunk_id -> { total, parts: string[], got: number } */
    this.chunks = new Map()
    this.retries = 0
    /** Highest seq seen per task, so a caller can follow one running task on its own. */
    this.seqByTask = new Map()
  }

  /** One page of rows, or null when the server had nothing new. `hasMore`: ask again at once. */
  async pull() {
    for (;;) {
      const query = new URLSearchParams({ [this.key]: this.id, limit: String(this.limit) })
      if (this.cursor) {
        query.set('after_task_id', this.cursor.after_task_id)
        query.set('after_seq', String(this.cursor.after_seq))
      }
      let res
      try {
        res = await this.request(`/projects/${encodeURIComponent(this.projectId)}/recording-events?${query}`)
      } catch (err) {
        // A network error: retry a few times with a growing pause.
        if (++this.retries > 4) throw err
        await sleep(500 * 2 ** this.retries)
        continue
      }
      if (res.status === 401 || res.status === 403) throw new AuthError(describe(res))
      if (res.status === 404) throw new NotFoundError(describe(res))
      if (res.status === 502 && TOO_LARGE.test(JSON.stringify(res.data))) {
        if (this.limit <= 1) throw new Error('a single recording event is larger than the API allows')
        this.limit = Math.max(1, Math.floor(this.limit / 2))
        continue
      }
      if (res.status !== 200) {
        if (++this.retries > 4 || res.status < 500) throw new Error(describe(res))
        await sleep(500 * 2 ** this.retries)
        continue
      }
      this.retries = 0
      const events = Array.isArray(res.data?.events) ? res.data.events : []
      const rows = this.assemble(events)
      // Small pages are cheap: grow back toward the starting size after a shrink.
      if (this.limit < this.maxLimit && JSON.stringify(events).length < 1_500_000) this.limit = Math.min(this.maxLimit, this.limit * 2)
      const next = res.data?.next_cursor ?? null
      const last = events[events.length - 1]
      if (next) this.cursor = next
      else if (last) this.cursor = { after_task_id: last.task_id, after_seq: last.seq }
      return { rows, hasMore: Boolean(next), count: events.length }
    }
  }

  /** Turns API rows into player rows, joining rrweb-chunk pieces. */
  assemble(events) {
    const rows = []
    for (const e of events) {
      this.seqByTask.set(e.task_id, Math.max(this.seqByTask.get(e.task_id) ?? -1, e.seq))
      if (e.event_type === 'rrweb') {
        rows.push({ kind: 'rrweb', event: e.payload, taskId: e.task_id, seq: e.seq })
      } else if (e.event_type === 'rrweb-chunk') {
        const c = e.payload
        let entry = this.chunks.get(c.chunk_id)
        if (!entry) this.chunks.set(c.chunk_id, (entry = { total: c.total, parts: new Array(c.total), got: 0 }))
        if (entry.parts[c.index] === undefined) entry.got++
        entry.parts[c.index] = c.data
        if (entry.got === entry.total) {
          this.chunks.delete(c.chunk_id)
          try {
            rows.push({ kind: 'rrweb', event: JSON.parse(entry.parts.join('')), taskId: e.task_id, seq: e.seq })
          } catch {
            // A corrupt chunk set drops that one event rather than the stream.
          }
        }
      } else {
        const p = e.payload ?? {}
        const row = {
          kind: 'note',
          type: e.event_type,
          text: String(p.text ?? p.message ?? p.action ?? ''),
          ts: e.client_ts ?? Date.parse(e.created_at),
          taskId: e.task_id,
          seq: e.seq,
        }
        if (p.kind === 'step') row.step = { index: p.index, action: String(p.action ?? '') }
        rows.push(row)
      }
    }
    return rows
  }
}

function describe(res) {
  const data = typeof res.data === 'string' ? res.data : JSON.stringify(res.data)
  return `Replay QA API answered ${res.status}: ${data.slice(0, 300)}`
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

/**
 * An rrweb event stream is renderable once it holds a Meta (type 4) followed by a
 * FullSnapshot (type 2).
 */
export function isRenderable(events) {
  for (let i = 1; i < events.length; i++) if (events[i].type === 2 && events[i - 1].type === 4) return true
  return false
}
