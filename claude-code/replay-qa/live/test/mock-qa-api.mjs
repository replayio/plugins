// A stand-in for https://qa.replay.io/api/v1, for tests and demos that must not spend credits.
// It answers the endpoints the relay reads, in the real response shapes, with the real
// constraints: a page whose JSON is over `maxPageBytes` answers 502 ResponseSizeTooLarge,
// events over `chunkBytes` are served as `rrweb-chunk` rows, and a recording marked `live`
// reveals its events over time.
//
//   const mock = await startMock({ projects: [...] })   // mock.url is the API base
//   mock.finish('run-1')                                  // a live run completes
//
// Scenario:
//   { projects: [{ id, name, journeys: [{ id, name }], runs: [{ id, journey_id, status,
//       events: rrwebEvents[], live?: { perSecond }, notes?: [...] }], explorations: [...] }] }

import http from 'node:http'

import { synthEvents } from './synth.mjs'

export async function startMock(scenario, { maxPageBytes = 1_500_000, chunkBytes = 600_000 } = {}) {
  const started = new Map() // recording source id -> when it began revealing
  const state = structuredClone(scenario)
  const calls = []

  const tasks = []
  for (const p of state.projects) {
    for (const run of p.runs ?? []) {
      run.taskId = run.taskId ?? `task-${run.id}`
      run.rows = rowsFor(run, chunkBytes)
      tasks.push({ project: p.id, run })
      if (run.live) started.set(run.id, Date.now())
    }
    for (const e of p.explorations ?? []) {
      e.taskId = e.taskId ?? `task-${e.id}`
      e.rows = rowsFor(e, chunkBytes)
      if (e.status === 'in-progress') started.set(e.id, Date.now())
    }
  }

  /** How many of an item's rows exist so far. */
  const visible = item => {
    if (!started.has(item.id)) return item.rows.length
    const n = Math.floor(((Date.now() - started.get(item.id)) / 1000) * (item.live?.perSecond ?? 4)) + 3
    return Math.min(item.rows.length, n)
  }

  let counter = 0
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x')
    calls.push(`${req.method} ${url.pathname}${url.search}`)
    let body = {}
    if (req.method !== 'GET') {
      let text = ''
      for await (const chunk of req) text += chunk
      try { body = text ? JSON.parse(text) : {} } catch {}
    }
    const json = (status, body) => {
      res.writeHead(status, { 'content-type': 'application/json' })
      res.end(JSON.stringify(body))
    }
    if (!/^Bearer .+/.test(req.headers.authorization ?? '')) return json(401, { error: 'missing token' })
    const parts = url.pathname.replace(/^\/api\/v1\/?/, '').split('/').filter(Boolean)
    const project = state.projects.find(p => p.id === parts[1])
    // PATCH /bugs/:id { status: 'fixed' } -> the affected journey is re-tested: a new live run
    if (req.method === 'PATCH' && parts[0] === 'bugs' && parts[1]) {
      const owner = state.projects.find(p => (p.bugs ?? []).some(b => b.id === parts[1]))
      const bug = owner?.bugs.find(b => b.id === parts[1])
      if (!bug) return json(404, { error: 'no such bug' })
      bug.status = body.status ?? bug.status
      if (body.status === 'fixed') {
        const journey = owner.journeys.find(j => j.id === bug.journey_id)
        api.addLiveRun(owner.id, { id: `run-retest-${++counter}`, journey_id: bug.journey_id, title: journey?.name ?? 'Retest', events: synthEvents({ title: `Retest: ${journey?.name ?? ''}`, steps: 40, stepMs: 250 }) })
      }
      return json(200, bug)
    }
    if (req.method === 'GET' && parts[0] === 'bugs' && parts[1]) {
      const bug = state.projects.flatMap(p => p.bugs ?? []).find(b => b.id === parts[1])
      return bug ? json(200, bug) : json(404, { error: 'no such bug' })
    }
    if (parts[0] === 'projects' && parts.length === 1) return json(200, { items: state.projects.map(p => ({ id: p.id, name: p.name })) })
    if (parts[0] !== 'projects' || !project) return json(404, { error: 'not found' })
    const sub = parts[2]
    const page = items => json(200, { items, total: items.length, page: 1, pageSize: items.length })

    // POST /projects/:id/explorations { prompt } -> a new running exploration
    if (req.method === 'POST' && sub === 'explorations') {
      const e = { id: `expl-mock-${++counter}`, status: 'in-progress', prompt: body.prompt ?? 'Explore the app and test the main features', events: synthEvents({ title: 'Exploration', steps: 60, stepMs: 250 }), live: { perSecond: 4 } }
      e.taskId = `task-${e.id}`
      e.rows = rowsFor(e, chunkBytes)
      ;(project.explorations ??= []).push(e)
      started.set(e.id, Date.now())
      return json(201, { id: e.id, project_id: project.id, prompt: e.prompt, status: 'in-progress', journeys_created: 0, journeys_updated: 0, started_at: new Date().toISOString() })
    }
    if (!sub) return json(200, { id: project.id, name: project.name, target_url: 'http://localhost:3000', status: 'active' })
    if (sub === 'journeys') {
      return page((project.journeys ?? []).map(j => {
        const last = [...(project.runs ?? [])].reverse().find(r => r.journey_id === j.id)
        return { ...j, last_run_id: last?.id ?? null, preview_run_id: last?.id ?? null, last_run_status: last?.status ?? null, last_run_at: last ? new Date().toISOString() : null }
      }))
    }
    if (sub === 'test-runs') return page((project.runs ?? []).map(r => ({ id: r.id, project_id: project.id, journey_id: r.journey_id, status: r.status, bugs_found_count: r.bugs ?? 0, goal: r.goal ?? r.title, journey_name: r.title, started_at: new Date().toISOString(), duration_seconds: 12, bug_titles: [] })))
    if (sub === 'explorations') return page((project.explorations ?? []).map(e => ({ id: e.id, project_id: project.id, status: e.status, prompt: e.prompt, started_at: new Date().toISOString() })))
    if (sub === 'tasks') {
      const want = url.searchParams.get('status')
      const all = [
        ...(project.runs ?? []).map(r => ({ id: r.taskId, kind: 'journey', test_run_id: r.id, exploration_id: null, status: r.status === 'in-progress' ? 'running' : 'completed' })),
        ...(project.explorations ?? []).map(e => ({ id: e.taskId, kind: 'exploration', test_run_id: null, exploration_id: e.id, status: e.status === 'in-progress' ? 'running' : 'completed' })),
      ]
      return page(want ? all.filter(t => t.status === want) : all)
    }
    if (sub === 'recording-events') {
      const q = url.searchParams
      const item = [...(project.runs ?? []), ...(project.explorations ?? [])].find(x => x.id === (q.get('test_run_id') ?? q.get('exploration_id')) || x.taskId === q.get('task_id'))
      if (!item) return json(404, { error: 'no such source' })
      const limit = Number(q.get('limit') ?? 100)
      const afterSeq = q.has('after_seq') ? Number(q.get('after_seq')) : -1
      const rows = item.rows.slice(0, visible(item)).filter(r => r.seq > afterSeq).slice(0, limit)
      const body = { source: Object.fromEntries([...q].filter(([k]) => /_id$/.test(k) && k !== 'after_task_id')), count: rows.length, events: rows, next_cursor: null }
      const all = item.rows.slice(0, visible(item)).filter(r => r.seq > afterSeq)
      if (all.length > rows.length) body.next_cursor = { after_task_id: item.taskId, after_seq: rows[rows.length - 1].seq }
      const text = JSON.stringify(body)
      if (text.length > maxPageBytes) return json(502, { errorType: 'Function.ResponseSizeTooLarge', errorMessage: 'Response payload size exceeded maximum allowed payload size (6291556 bytes).' })
      res.writeHead(200, { 'content-type': 'application/json' })
      return res.end(text)
    }
    return json(404, { error: 'not found' })
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))

  const api = {
    url: `http://127.0.0.1:${server.address().port}/api/v1`,
    calls,
    /** A live run or exploration finishes: all its events exist and its status flips. */
    finish(id) {
      started.delete(id)
      for (const p of state.projects) {
        for (const r of p.runs ?? []) if (r.id === id) { r.status = 'completed'; r.live = null }
        for (const e of p.explorations ?? []) if (e.id === id) e.status = 'completed'
      }
    },
    /** Adds a run that is already running. */
    addLiveRun(projectId, run) {
      const p = state.projects.find(x => x.id === projectId)
      run.taskId = run.taskId ?? `task-${run.id}`
      run.rows = rowsFor(run, chunkBytes)
      run.status = 'in-progress'
      run.live = run.live ?? { perSecond: 4 }
      ;(p.runs ??= []).push(run)
      started.set(run.id, Date.now())
    },
    close: () => new Promise(resolve => { server.closeAllConnections?.(); server.close(resolve) }),
  }
  return api
}

/** API rows for an item's rrweb events (plus its notes), chunking the oversized ones. */
function rowsFor(item, chunkBytes) {
  const rows = []
  let seq = 0
  const base = item.events[0]?.timestamp ?? Date.now()
  const push = (event_type, payload, client_ts) =>
    rows.push({ id: `tev-${item.id}-${seq}`, task_id: item.taskId, seq: seq++, event_type, client_ts: client_ts ?? null, payload, created_at: new Date(base).toISOString(), document_id: null })
  for (const ev of item.events) {
    const text = JSON.stringify(ev)
    if (text.length > chunkBytes) {
      const total = Math.ceil(text.length / chunkBytes)
      const chunk_id = `chunk-${item.id}-${seq}`
      for (let index = 0; index < total; index++) push('rrweb-chunk', { chunk_id, index, total, data: text.slice(index * chunkBytes, (index + 1) * chunkBytes) }, ev.timestamp)
    } else {
      push('rrweb', ev, ev.timestamp)
    }
    if (ev.type === 3 && ev.data?.texts?.[1]) push('note', { kind: 'step', index: seq, action: ev.data.texts[1].value, text: ev.data.texts[1].value }, ev.timestamp)
  }
  return rows
}
