#!/usr/bin/env node
// The host-neutral face of the rrweb recorder. Every plugin uses it: the Claude Code mod for the
// daemon, the other hosts' hooks and scripts for everything.
//
//   rrweb.mjs ensure                      start the relay if it is not running; print where it is
//   rrweb.mjs open <url> [--session s]    open Replay Chromium with agent-browser and record it
//   rrweb.mjs attach [--session s]        record a session's browser that is already running
//   rrweb.mjs close [--session s]         close it, finish its .rrweb, upload its Replay recording
//   rrweb.mjs stop                        the end-of-turn safety net: the same for this directory's live sessions
//   rrweb.mjs list [--json]               every recording, newest first
//   rrweb.mjs play [latest|session|id|path] [--no-open]   stream one, live or historical, in a browser
//   rrweb.mjs hook                        for shell hooks: reads the host's hook JSON on stdin; never fails
//
// Output is JSON unless a verb says otherwise, and every viewer_url carries the relay's token.

import { execFile, spawn } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { netEffect, openedSession, parseBrowserCommands } from './detect.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const DATA_DIR = process.env.REPLAY_RRWEB_DIR || path.join(os.homedir(), '.replay', 'rrweb')
const RELAY_FILE = path.join(DATA_DIR, 'relay.json')
const RELAY_VERSION = 2
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

/** The Replay Chromium agent-browser should launch, and the variables that make it record. */
export function replayEnv(env = process.env) {
  const chromium = process.platform === 'darwin'
    ? path.join(os.homedir(), '.replay', 'runtimes', 'Replay-Chromium.app', 'Contents', 'MacOS', 'Chromium')
    : path.join(os.homedir(), '.replay', 'runtimes', 'chrome-linux', 'chrome')
  return {
    ...env,
    AGENT_BROWSER_EXECUTABLE_PATH: env.AGENT_BROWSER_EXECUTABLE_PATH || chromium,
    RECORD_ALL_CONTENT: env.RECORD_ALL_CONTENT || '1',
    RECORD_REPLAY_VERBOSE: env.RECORD_REPLAY_VERBOSE || '1',
  }
}

function run(command, args, { env = process.env, timeout = 120_000, cwd } = {}) {
  return new Promise(resolve => {
    execFile(command, args, { env, timeout, cwd, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({ ok: !err, stdout: String(stdout), stderr: String(stderr), error: err?.message ?? null })
    })
  })
}

// ---------------------------------------------------------------- the relay

function readRelayFile() {
  try { return JSON.parse(fs.readFileSync(RELAY_FILE, 'utf8')) } catch { return null }
}

const relayUrl = (relay, route) => `http://127.0.0.1:${relay.port}${route}${route.includes('?') ? '&' : '?'}token=${relay.token}`

async function isHealthy(relay) {
  try {
    const res = await fetch(relayUrl(relay, '/health'), { signal: AbortSignal.timeout(1500) })
    return res.ok ? await res.json() : null
  } catch {
    return null
  }
}

/** The running daemon, or a new one. An older version makes way once nothing is live on it. */
async function ensureRelay() {
  fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 })
  const known = readRelayFile()
  if (known) {
    const health = await isHealthy(known)
    if (health?.version === RELAY_VERSION) return known
    if (health) {
      const res = await fetch(relayUrl(known, '/shutdown'), { method: 'POST', body: '{"ifIdle":true}' }).catch(() => null)
      if (res?.status === 409) return known
      await sleep(300)
    }
    // Dead or gone: its file must not stop the next one from starting.
    try { if (readRelayFile()?.pid === known.pid) fs.unlinkSync(RELAY_FILE) } catch {}
  }
  const log = fs.openSync(path.join(DATA_DIR, 'relay.log'), 'a', 0o600)
  const child = spawn(process.execPath, [path.join(HERE, 'relay.mjs')], { detached: true, stdio: ['ignore', log, log] })
  child.unref()
  fs.closeSync(log)
  for (let i = 0; i < 100; i++) {
    const relay = readRelayFile()
    if (relay && (await isHealthy(relay))) return relay
    await sleep(100)
  }
  throw new Error(`the rrweb relay did not start: see ${path.join(DATA_DIR, 'relay.log')}`)
}

async function relayJson(relay, route, body) {
  const res = await fetch(relayUrl(relay, route), body === undefined
    ? {}
    : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  const text = await res.text()
  const parsed = text ? JSON.parse(text) : null
  if (!res.ok) throw new Error(parsed?.error ?? `relay answered ${res.status}`)
  return parsed
}

// ---------------------------------------------------------------- recording

async function cdpUrl(session) {
  const res = await run('agent-browser', ['--session', session, 'get', 'cdp-url'], { env: replayEnv(), timeout: 30_000 })
  const url = res.stdout.split('\n').map(line => line.trim()).find(line => /^wss?:\/\//.test(line))
  if (!res.ok || !url) throw new Error(`agent-browser has no browser for session ${session}: ${(res.stderr || res.stdout || res.error || '').trim().slice(-200)}`)
  return url
}

async function attach(relay, session, cwd) {
  const { recording, viewerUrl } = await relayJson(relay, '/recordings', {
    id: `rec_${crypto.randomUUID().slice(0, 12)}`,
    session,
    cwd: cwd ?? process.cwd(),
    cdp: await cdpUrl(session),
  })
  return { agent_browser_session: session, recording_id: recording.id, rrweb_file: recording.file, status: recording.status, viewer_url: viewerUrl }
}

/** Uploads a finished recording's Replay recordings. Signed out, it says so instead of opening a sign-in. */
async function upload(relay, id) {
  // Replay Chromium finishes writing its recording as the browser closes.
  await sleep(3000)
  try {
    const links = await relayJson(relay, `/recordings/${encodeURIComponent(id)}/replay/upload`, { login: false })
    return { replay_recordings: links.map(l => ({ id: l.id, url: l.url, upload_status: l.uploadStatus })) }
  } catch (err) {
    return { upload_error: err.message }
  }
}

async function closeSession(relay, session) {
  const resolved = await relayJson(relay, `/resolve?ref=${encodeURIComponent(session)}`).catch(() => null)
  const closed = await run('agent-browser', ['--session', session, 'close'], { timeout: 30_000 })
  await relayJson(relay, `/sessions/${encodeURIComponent(session)}/end`, {}).catch(() => null)
  const out = { agent_browser_session: session, closed: closed.ok }
  if (!resolved) return out
  return { ...out, recording_id: resolved.id, rrweb_file: resolved.file, viewer_url: resolved.viewerUrl, ...(await upload(relay, resolved.id)) }
}

// -------------------------------------------------------------------- verbs

function parseArgs(argv) {
  const args = { _: [] }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (!arg.startsWith('--')) { args._.push(arg); continue }
    const [key, inline] = arg.slice(2).split(/=(.*)/s)
    if (inline !== undefined) args[key] = inline
    else if (argv[i + 1] !== undefined && !argv[i + 1].startsWith('--')) args[key] = argv[++i]
    else args[key] = true
  }
  return args
}

const print = value => process.stdout.write(`${JSON.stringify(value, null, 2)}\n`)
const defaultSession = () => process.env.AGENT_BROWSER_SESSION || 'default'

function openInBrowser(url) {
  const opener = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'explorer' : 'xdg-open'
  spawn(opener, [url], { detached: true, stdio: 'ignore' }).on('error', () => {}).unref()
}

async function hook() {
  let input = ''
  for await (const chunk of process.stdin) input += chunk
  let event = {}
  try { event = JSON.parse(input) } catch {}
  const command = event.tool_input?.command ?? event.tool_input?.args?.command ?? event.command ?? event.shell_command ?? event.args?.command ?? ''
  const cwd = event.cwd ?? process.cwd()
  const commands = netEffect(parseBrowserCommands(String(command), cwd))
  if (commands.length === 0) return
  const relay = await ensureRelay()
  const output = String(event.tool_response?.stdout ?? event.output ?? event.stdout ?? '')
  for (const c of commands) {
    const session = c.session ?? openedSession(output)
    if (c.kind === 'open' && session) {
      const started = await attach(relay, session, c.cwd ?? cwd)
      process.stderr.write(`[replayio] recording ${session} to ${started.rrweb_file}\n[replayio] watch: ${started.viewer_url}\n`)
    } else if (c.kind === 'close') {
      const live = await relayJson(relay, '/recordings')
      for (const rec of live.filter(r => r.status === 'live' && (c.all || r.session === session))) {
        await relayJson(relay, `/sessions/${encodeURIComponent(rec.session)}/end`, {})
        const uploaded = await upload(relay, rec.id)
        if (uploaded.upload_error) process.stderr.write(`[replayio] ${uploaded.upload_error}\n`)
      }
    }
  }
}

async function main() {
  const [verb = 'list', ...rest] = process.argv.slice(2)
  const args = parseArgs(rest)
  if (verb === 'hook') {
    await hook().catch(err => process.stderr.write(`[replayio] ${err.message}\n`))
    return
  }
  // Nothing running, nothing live: the end-of-turn hook must not start a daemon to find that out.
  if (verb === 'stop' && !readRelayFile()) return print({ closed: [] })
  const relay = await ensureRelay()
  const session = String(args.session || defaultSession())
  switch (verb) {
    case 'ensure':
      return print(relay)
    case 'open': {
      const url = args._[0] || args.url
      if (!url) throw new Error('Provide a URL: rrweb.mjs open <url> [--session name]')
      const name = String(args.session || process.env.AGENT_BROWSER_SESSION || `replayio-${Date.now()}`)
      const env = replayEnv()
      if (!fs.existsSync(env.AGENT_BROWSER_EXECUTABLE_PATH)) throw new Error(`Replay Chromium is not at ${env.AGENT_BROWSER_EXECUTABLE_PATH}: run replayio install`)
      const opened = await run('agent-browser', ['--session', name, 'open', String(url)], { env, timeout: 120_000 })
      if (!opened.ok) throw new Error(`agent-browser open failed: ${(opened.stderr || opened.stdout || opened.error || '').trim().slice(-400)}`)
      return print({ url, replay_chromium_path: env.AGENT_BROWSER_EXECUTABLE_PATH, ...(await attach(relay, name, process.cwd())) })
    }
    case 'attach':
      return print(await attach(relay, session, process.cwd()))
    case 'close':
      return print(await closeSession(relay, session))
    case 'stop': {
      const live = (await relayJson(relay, '/recordings')).filter(r => r.status === 'live' && r.cwd === process.cwd())
      const closed = []
      for (const rec of live) closed.push(await closeSession(relay, rec.session))
      return print({ closed })
    }
    case 'list': {
      const all = await relayJson(relay, '/recordings?all=1')
      if (args.json) return print(all)
      if (all.length === 0) return void process.stdout.write('No rrweb recordings yet.\n')
      for (const r of all.slice(0, 30)) {
        process.stdout.write(`${r.status === 'live' ? '● live' : '■     '} ${new Date(r.startedAt).toLocaleString()}  ${r.session}  ${r.url ?? ''}\n         ${r.file}\n`)
      }
      return
    }
    case 'play': {
      const rec = await relayJson(relay, `/resolve?ref=${encodeURIComponent(args._[0] ?? 'latest')}`)
      if (!args['no-open']) openInBrowser(rec.viewerUrl)
      return print({ recording_id: rec.id, agent_browser_session: rec.session, status: rec.status, url: rec.url, rrweb_file: rec.file, viewer_url: rec.viewerUrl })
    }
    default:
      throw new Error(`Unknown verb ${verb}: ensure, open, attach, close, stop, list, play, hook`)
  }
}

main().catch(err => {
  process.stderr.write(`${err.message}\n`)
  process.exit(1)
})
