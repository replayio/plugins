// What the relay needs to know about Replay QA and its servers. Recordings themselves are read by
// `replayqa recording-events`, which owns the API's paging and chunking.

export class AuthError extends Error {}
export class NotFoundError extends Error {}

/**
 * An rrweb event stream is renderable once it holds a Meta (type 4) followed by a
 * FullSnapshot (type 2).
 */
export function isRenderable(events) {
  for (let i = 1; i < events.length; i++) if (events[i].type === 2 && events[i - 1].type === 4) return true
  return false
}

// ------------------------------------------------------------------ servers

/**
 * The API base for a QA server named any way people name one: an API base (`…/api/v1`), the QA
 * URL `replayqa --qa-url` and REPLAY_QA_URL take, or a dashboard URL such as a PR preview's
 * `https://pr-1--qa.netlify.app/projects/proj-x/test-runs/…`. Null when it is not a URL.
 */
export function apiBaseOf(value) {
  let url
  try { url = new URL(String(value ?? '').trim()) } catch { return null }
  if (!/^https?:$/.test(url.protocol)) return null
  const api = /^(.*?\/api\/v\d+)(?:\/|$)/.exec(url.pathname)
  return `${url.origin}${api ? api[1] : '/api/v1'}`
}

/** project id -> API base of each running `replayqa proxy|run --project <id> --qa-url <url>` in a `ps` listing. */
export function tunnelServers(psOutput) {
  const map = new Map()
  for (const line of psOutput.split('\n')) {
    if (!/\breplayqa\b/.test(line) || !/\s(?:proxy|run)\s/.test(` ${line} `)) continue
    const project = /--project(?:=|\s+)["']?(proj-[A-Za-z0-9_-]+)/.exec(line)?.[1]
    const qaUrl = /--qa-url(?:=|\s+)["']?([^\s"']+)/.exec(line)?.[1]
    const base = qaUrl && apiBaseOf(qaUrl)
    if (project && base) map.set(project, base)
  }
  return map
}
