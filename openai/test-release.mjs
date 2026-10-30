import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root = dirname(fileURLToPath(import.meta.url));
const temporary = mkdtempSync(join(tmpdir(), 'replayio-release-test-'));
test.after(() => rmSync(temporary, { recursive: true, force: true }));

function packageCopy(name) {
  const target = join(temporary, name);
  cpSync(join(root, 'replayio'), join(target, 'replayio'), { recursive: true });
  cpSync(join(root, 'build-release.py'), join(target, 'build-release.py'));
  return target;
}

function build(target, ...args) {
  return spawnSync('python3', [join(target, 'build-release.py'), ...args], { encoding: 'utf8' });
}

test('release ZIP is reproducible and contains only the distributable package', () => {
  const target = packageCopy('reproducible');
  const first = build(target);
  assert.equal(first.status, 0, first.stderr);
  const report = JSON.parse(first.stdout);
  const bytes = readFileSync(report.zip);
  assert.equal(build(target).status, 0);
  assert.deepEqual(readFileSync(report.zip), bytes);
  const listing = spawnSync('python3', ['-c',
    'import json,sys,zipfile; print(json.dumps(zipfile.ZipFile(sys.argv[1]).namelist()))', report.zip],
  { encoding: 'utf8' });
  assert.equal(listing.status, 0, listing.stderr);
  assert.deepEqual(JSON.parse(listing.stdout), [
    'LICENSE', 'assets/replayio.svg', 'mcp.json', 'plugin.json', 'skills/replayio/SKILL.md',
  ]);
});

test('unreviewed files and symlinks cannot enter the ZIP', () => {
  const target = packageCopy('extra-files');
  writeFileSync(join(target, 'replayio', '.app.json'), '{"apps":{}}');
  assert.notEqual(build(target).status, 0);
  rmSync(join(target, 'replayio', '.app.json'));
  symlinkSync(join(target, 'replayio', 'LICENSE'), join(target, 'replayio', 'linked-license'));
  assert.notEqual(build(target).status, 0);
});

test('OAuth client secrets are rejected before packaging', () => {
  const target = packageCopy('credentials');
  const path = join(target, 'replayio', 'mcp.json');
  const mcp = JSON.parse(readFileSync(path));
  mcp.mcpServers.replay.extensions['com.openai'].auth.clientSecret = 'synthetic-test-value';
  writeFileSync(path, JSON.stringify(mcp));
  const result = build(target);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /credential field/);
  assert(!result.stderr.includes('synthetic-test-value'));
});

// This fixture replaces fetch entirely; no test sends a credential over the network.
const fixture = join(temporary, 'fetch-fixture.mjs');
writeFileSync(fixture, `
process.env.REPLAYIO_MCP_TOKEN = 'synthetic-test-value';
const mode = process.env.REPLAY_RELEASE_TEST_MODE;
const uri = 'ui://replay/recording-preview.html';
const key = 'replay.io/recording-preview';
const scopes = ['openid','profile','email'];
globalThis.fetch = async (url, options = {}) => {
  const address = String(url);
  const json = value => new Response(JSON.stringify(value), {headers:{'content-type':'application/json'}});
  if (address.includes('oauth-protected-resource')) return json({
    resource:'https://dispatch.replay.io/mcp', authorization_servers:['https://dispatch.replay.io'], scopes_supported:scopes,
  });
  if (address.includes('oauth-authorization-server')) return json({issuer:'https://dispatch.replay.io',
    code_challenge_methods_supported:['S256'], registration_endpoint:'https://dispatch.replay.io/oauth/register'});
  if (!options.headers.Authorization) return new Response(null,{status:401,headers:{
    'www-authenticate':'Bearer resource_metadata="https://dispatch.replay.io/.well-known/oauth-protected-resource/mcp"'}});
  const request = JSON.parse(options.body);
  let result = {};
  if (request.method === 'tools/list') result = { tools:['RecordingOverview','RecordingPreview'].map(name => ({
    name, inputSchema:{properties:{recordingId:{type:'string'}}}, annotations:{readOnlyHint:true},
    _meta:{securitySchemes:[{type:'oauth2',scopes}], ...(name === 'RecordingOverview'
      ? {ui:{resourceUri:uri},'openai/outputTemplate':uri}
      : {ui:{visibility:['app']},'openai/visibility':'private'})},
  }))};
  if (request.method === 'resources/read') result = {contents:[{uri,mimeType:'text/html;profile=mcp-app',
    text:'<!doctype html><html></html>',_meta:{ui:{csp:{connectDomains:[],resourceDomains:mode === 'wildcard' ? ['https://*'] : []}},
    'openai/widgetCSP':{resource_domains:[]}}}]};
  if (request.method === 'tools/call') {
    const {name,arguments:args} = request.params;
    const {recordingId,cursor = 0} = args;
    if (recordingId === 'denied') result = {isError:true,content:[{type:'text',text:'Access denied'}],
      ...(mode === 'denied-leak' ? {_meta:{[key]:{recordingId}}} : {})};
    else if (name === 'RecordingOverview') result = {content:[{type:'text',text:'Overview'}],_meta:{[key]:{recordingId}}};
    else result = {content:[{type:'text',text:'Preview frame'}],_meta:{[key]:{recordingId,durationMs:2000,
      snapshotCount:recordingId === 'node' ? 0 : 2,
      nextCursor:recordingId === 'node' || cursor === 1 ? null : 1,
      events:recordingId === 'node' ? [] : [{type:2,timestamp:cursor * 1000,data:{}}],
      ...(recordingId === 'node' ? {reason:'No browser DOM'} : {})}}};
  }
  const message = {jsonrpc:'2.0',id:request.id,result};
  return mode === 'sse' ? new Response('event: message\\ndata: '+JSON.stringify(message)+'\\n\\n',
    {headers:{'content-type':'text/event-stream'}}) : json(message);
};
`);

function preflight(mode) {
  return spawnSync(process.execPath, ['--import', fixture, join(root, 'check-server.mjs'),
    '--recording-id', 'browser', '--node-recording-id', 'node', '--denied-recording-id', 'denied'],
  { encoding: 'utf8', env: { ...process.env, REPLAY_RELEASE_TEST_MODE: mode }, timeout: 20000 });
}

for (const mode of ['json', 'sse']) {
  test('server preflight checks authenticated frames and access denial over ' + mode, () => {
    const result = preflight(mode);
    assert.equal(result.status, 0, result.stderr);
    const report = JSON.parse(result.stdout);
    assert.equal(report.authenticated.browserRecording.frames, 2);
    assert.equal(report.authenticated.nodeRecording, 'passed');
    assert.equal(report.authenticated.deniedRecording, 'passed');
    assert(!result.stdout.includes('synthetic-test-value'));
  });
}

for (const mode of ['wildcard', 'denied-leak']) {
  test('server preflight rejects ' + mode, () => {
    const result = preflight(mode);
    assert.equal(result.status, 1);
    assert(!result.stderr.includes('synthetic-test-value'));
  });
}
