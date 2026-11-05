/* @jsx h */

// What the canvas pane shows for a folder rather than a project: the index of its projects, or the list
// to set one up. These are native rows rather than the canvas screencast: in a docked pane a 1600px page
// scaled to fit is too small to read, a command in a picture cannot be selected and copied, a field in one
// cannot be typed in, and this is what a person sees first, before Replay Chromium or a terminal with
// graphics are known to be there. The browser view of the same thing is live/folder.html.

export type DetectedProject = { project_id: string; path: string; qa_url: string | null }

export type DetectedApp = {
  path: string
  name: string
  kind: 'app' | 'maybe'
  why: string
  dev_command?: string | null
  port?: number | null
  port_source?: string
  port_shared_with?: string[]
  /** How to start it: run `args` with the pinned CLI, from `cwd`. */
  setup?: { target_url: string; cwd: string; args: string[]; command: string; config_path: string }
}

/** What `replayqa detect --json` prints. */
export type Detection = {
  root: string
  name: string
  mode: 'configured' | 'workspace' | 'single' | 'none'
  projects: DetectedProject[]
  workspace: { tools: string[]; package_manager: string | null; root?: string }
  apps: DetectedApp[]
  libraries: number
  truncated?: boolean
}

export type Tunnel = {
  key: string
  label: string
  targetUrl: string | null
  status: string
  text: string
  isRunning: boolean
  projectId: string | null
  qaUrl: string | null
  error: string | null
  note: string | null
  tail: string[]
}

export type Summary = { name?: string | null; error?: string | null; server?: string | null }

export type FolderData = {
  view: 'index' | 'setup'
  /** The folder's name, when there is no detection to take it from. */
  name: string
  detection: Detection | null
  /** Why `replayqa detect` did not run, as a sentence. */
  why: string | null
  /** What the person last pressed, while it runs. */
  busy: string | null
  error: string | null
  summaries: Record<string, Summary>
  tunnels: Tunnel[]
  /** The app waiting to be confirmed, by its setup's cwd, and whether its port is taken. */
  confirm: { key: string; isBusy: boolean } | null
  /** How the person is signed in, in words. */
  signIn: string
}

export type FolderActions = {
  openProject: (project: DetectedProject) => void
  askToStart: (app: DetectedApp) => void
  start: (app: DetectedApp, noApp: boolean) => void
  cancelStart: () => void
  stop: (tunnel: Tunnel) => void
  openTunnel: (tunnel: Tunnel) => void
  copy: (text: string) => void
  use: (value: string) => void
  test: (value: string) => void
  openInBrowser: () => void
  close: () => void
}

/** The elements of the surface drawn on; `mobile` has no Input. */
export type FolderUi = { Box: any; Text: any; Button: any; Input?: any }

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`
const hotkeyFor = (i: number) => (i < 9 ? String(i + 1) : undefined)

function indexRows(ui: FolderUi, data: FolderData, on: FolderActions) {
  const { Box, Text, Button } = ui
  const projects = data.detection?.projects ?? []
  return (
    <Box flexDirection="column" gap={1}>
      {data.detection?.truncated ? <Text dimColor wrap="wrap">This folder is large, so the search for configs stopped early; there may be more.</Text> : null}
      {projects.map((project, i) => {
        const summary = data.summaries[project.project_id]
        const where = project.path === '.' ? 'this folder' : project.path
        const server = summary?.server ?? (project.qa_url ? hostOf(project.qa_url) : null)
        return (
          <Box key={`row:${project.project_id}`} flexDirection="column">
            <Button key={`open:${project.project_id}`} plain hotkey={hotkeyFor(i)} onPress={() => on.openProject(project)}>
              {summary?.name ?? project.project_id} <Text dimColor>{where}</Text>
            </Button>
            {summary?.name ? <Text dimColor wrap="truncate-end">{project.project_id}</Text> : null}
            {server ? <Text dimColor wrap="truncate-end">on {server}</Text> : null}
            {summary?.error ? <Text color="red" wrap="wrap">⚠ {summary.error}</Text> : null}
          </Box>
        )
      })}
    </Box>
  )
}

function hostOf(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return url
  }
}

function appBlock(ui: FolderUi, data: FolderData, on: FolderActions, app: DetectedApp, i: number) {
  const { Box, Text, Button } = ui
  const key = app.setup?.cwd ?? app.path
  const tunnel = data.tunnels.find(t => t.key === key)
  const isConfirming = data.confirm?.key === key
  const port = app.port ? `port ${app.port} (${app.port_source})` : 'port unknown'
  const shared = app.port_shared_with?.length ? `, shared with ${plural(app.port_shared_with.length, 'other')}` : ''
  return (
    <Box key={`app:${app.path}`} flexDirection="column">
      <Text wrap="wrap"><Text bold>{app.name}</Text> <Text dimColor>{app.path === '.' ? 'this folder' : app.path}{app.kind === 'maybe' ? ' · unclear' : ''}</Text></Text>
      <Text dimColor wrap="wrap">{app.why} · {port}{shared}</Text>
      {app.setup ? <Text dimColor wrap="wrap">$ {app.setup.command}</Text> : <Text dimColor wrap="wrap">No command to start it was found.</Text>}
      {tunnel?.isRunning ? (
        <Box flexDirection="column">
          <Text color={tunnel.status === 'ready' ? 'green' : undefined} wrap="wrap">{tunnel.text}</Text>
          {tunnel.note ? <Text dimColor wrap="wrap">{tunnel.note}</Text> : null}
          {tunnel.error ? <Text color="red" wrap="wrap">⚠ {tunnel.error}</Text> : null}
          <Box flexDirection="row" gap={1} flexWrap="wrap">
            {tunnel.projectId ? <Button key={`canvas:${key}`} variant="primary" label="Open dashboard" onPress={() => on.openTunnel(tunnel)} /> : null}
            <Button key={`stop:${key}`} label="Stop" onPress={() => on.stop(tunnel)} />
          </Box>
        </Box>
      ) : isConfirming && app.setup ? (
        <Box flexDirection="column">
          <Text wrap="wrap">This runs the command above, creates a Replay QA project in {app.setup.config_path}, and starts testing once the tunnel is up, which uses QA credits.</Text>
          {data.confirm?.isBusy ? <Text color="red" wrap="wrap">Something is already listening on port {app.port}.</Text> : null}
          <Box flexDirection="row" gap={1} flexWrap="wrap">
            {data.confirm?.isBusy ? <Button key={`attach:${key}`} variant="primary" label="Use what is running" onPress={() => on.start(app, true)} /> : null}
            <Button key={`confirm:${key}`} {...(data.confirm?.isBusy ? {} : { variant: 'primary' as const })} label={data.confirm?.isBusy ? 'Start anyway' : 'Start'} onPress={() => on.start(app, false)} />
            <Button key={`cancel:${key}`} label="Cancel" onPress={on.cancelStart} />
          </Box>
        </Box>
      ) : app.setup ? (
        <Box flexDirection="column">
          {tunnel?.error ? <Text color="red" wrap="wrap">⚠ {tunnel.error}</Text> : null}
          {/* The app's own last words say why it would not start. */}
          {tunnel?.error ? tunnel.tail.filter(line => !line.includes(tunnel.error!)).map((line, n) => <Text key={`tail:${key}:${n}`} dimColor wrap="truncate-end">{line}</Text>) : null}
          <Box flexDirection="row" gap={1} flexWrap="wrap">
            <Button key={`start:${key}`} variant="primary" hotkey={hotkeyFor(i)} label={tunnel ? 'Start again' : 'Start'} onPress={() => on.askToStart(app)} />
            <Button key={`copy:${key}`} label="Copy command" onPress={() => on.copy(app.setup!.command)} />
          </Box>
        </Box>
      ) : null}
    </Box>
  )
}

function setupRows(ui: FolderUi, data: FolderData, on: FolderActions) {
  const { Box, Text, Input } = ui
  const detection = data.detection
  const apps = detection?.apps ?? []
  return (
    <Box flexDirection="column" gap={1}>
      {data.why ? <Text color="yellow" wrap="wrap">{data.why}</Text> : null}
      {detection && !detection.projects.length ? <Text wrap="wrap">This folder has no Replay QA project yet.</Text> : null}
      {!detection ? <Text wrap="wrap">No .replay/config.json names a project for this folder.</Text> : null}
      {apps.length ? <Text dimColor wrap="wrap">These are suggestions from reading the files here, and nothing has been run. Check each command and port before starting one: ports are guesses, and apps collide on them.</Text> : null}
      {apps.map((app, i) => appBlock(ui, data, on, app, i))}
      {detection && !apps.length ? (
        <Text wrap="wrap">{detection.mode === 'none' ? 'Nothing was found here to test: no package.json, and no Replay QA config.' : 'Nothing here looks like an app Replay QA could start: no package has a dev server.'}</Text>
      ) : null}
      <Box flexDirection="column">
        <Text bold>Use an existing project</Text>
        <Text dimColor wrap="wrap">Writes qa-project-id to .replay/config.json for this folder. Nothing is created or run.</Text>
        {Input
          ? <Input key="use" placeholder="proj-… or a dashboard URL" submitLabel="use it" onSubmit={(value: string) => { if (value.trim()) on.use(value.trim()) }} />
          : <Text dimColor wrap="wrap">/replayqa use &lt;project id or dashboard URL&gt;</Text>}
      </Box>
      <Box flexDirection="column">
        <Text bold>Test a public URL</Text>
        <Text dimColor wrap="wrap">Creates a Replay QA project for it. Testing starts at once and uses QA credits.</Text>
        {Input
          ? <Input key="test" placeholder="https://…" submitLabel="test it" onSubmit={(value: string) => { if (value.trim()) on.test(value.trim()) }} />
          : <Text dimColor wrap="wrap">/replayqa test &lt;url&gt;</Text>}
      </Box>
    </Box>
  )
}

function headerLine(data: FolderData): string {
  const detection = data.detection
  if (data.view === 'index') return plural(detection?.projects.length ?? 0, 'Replay QA project')
  if (!detection) return ''
  const apps = detection.apps
  const unclear = apps.filter(app => app.kind === 'maybe').length
  return [
    detection.workspace.tools.join(' + '),
    plural(apps.length - unclear, 'app'),
    unclear ? `${unclear} unclear` : '',
    detection.libraries ? plural(detection.libraries, 'library', 'libraries') : '',
  ].filter(Boolean).join(' · ')
}

/** The pane's body for a folder, ending in the footer every view of it has. */
export function drawFolder(ui: FolderUi, data: FolderData, on: FolderActions) {
  const { Box, Text, Button } = ui
  return (
    <Box flexDirection="column" gap={1}>
      <Box flexDirection="row" gap={2} flexWrap="wrap">
        <Text bold wrap="truncate-end">{data.detection?.name ?? data.name}</Text>
        <Text dimColor wrap="wrap">{headerLine(data)}</Text>
      </Box>
      <Text dimColor wrap="wrap">{data.signIn}</Text>
      {data.busy ? <Text wrap="wrap">{data.busy}</Text> : null}
      {data.error ? <Text color="red" wrap="wrap">⚠ {data.error}</Text> : null}
      {data.view === 'index' ? indexRows(ui, data, on) : setupRows(ui, data, on)}
      <Box flexDirection="row" gap={1} height={1} overflow="hidden">
        <Button key="open" label="Open in browser" onPress={on.openInBrowser} />
        <Button key="close" label="Close" onPress={on.close} />
        <Text dimColor wrap="truncate-end">{data.view === 'index' ? 'choose a project to open its canvas' : 'Tab walks these · /replayqa start <path> works too'}</Text>
      </Box>
    </Box>
  )
}
