#!/usr/bin/env node
// Read-only release checks. Tokens and recording contents are never printed.
import assert from 'node:assert/strict';
import { parseArgs } from 'node:util';

const { values } = parseArgs({ options: {
  endpoint: { type: 'string', default: 'https://dispatch.replay.io/mcp' },
  'recording-id': { type: 'string' },
  'node-recording-id': { type: 'string' },
  'denied-recording-id': { type: 'string' },
} });
const endpoint = new URL(values.endpoint);
assert(endpoint.protocol === 'https:' && !endpoint.username && !endpoint.password
  && !endpoint.search && !endpoint.hash, 'Use an HTTPS MCP endpoint without credentials or a query');
const token = process.env.REPLAYIO_MCP_TOKEN;
const uiUri = 'ui://replay/recording-preview.html';
const metaKey = 'replay.io/recording-preview';
const scopes = ['openid', 'profile', 'email'];
const report = { endpoint: endpoint.href, public: {}, authenticated: 'not run' };
let requestId = 0;

async function getJson(url) {
  const response = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(20000) });
  assert(response.ok, 'Public metadata request failed with HTTP ' + response.status);
  return response.json();
}

async function rpc(method, params, authenticated = true) {
  const id = ++requestId;
  const response = await fetch(endpoint, {
    method: 'POST', redirect: 'error', signal: AbortSignal.timeout(300000),
    headers: {
      'Content-Type': 'application/json', Accept: 'application/json, text/event-stream',
      'MCP-Protocol-Version': '2025-06-18',
      ...(authenticated ? { Authorization: 'Bearer ' + token } : {}),
    },
    body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
  });
  assert(response.ok, method + ' failed with HTTP ' + response.status);
  const body = await response.text();
  let messages;
  if (response.headers.get('content-type')?.includes('text/event-stream')) {
    messages = body.split(/\r?\n\r?\n/).flatMap(event => {
      const data = event.split(/\r?\n/).filter(line => line.startsWith('data:'))
        .map(line => line.slice(5).trimStart()).join('\n');
      return data ? [JSON.parse(data)] : [];
    });
  } else {
    messages = [JSON.parse(body)];
  }
  const message = messages.find(item => item.id === id);
  assert(message, method + ' did not return a matching JSON-RPC response');
  assert(!message.error, method + ' returned a JSON-RPC error');
  return message.result;
}

async function callTool(name, recordingId, rest = {}) {
  return rpc('tools/call', { name, arguments: { recordingId, ...rest } });
}

function previewPage(result) {
  assert(!result.isError, 'RecordingPreview returned a tool error');
  const page = result._meta?.[metaKey];
  assert(page && Array.isArray(page.events), 'Preview frames must be in result _meta');
  assert(result.content?.every(item => item.type !== 'text' || !item.text.includes('"events":')),
    'Raw preview events must not be exposed as model text');
  return page;
}

try {
  const protectedUrl = new URL('/.well-known/oauth-protected-resource' + endpoint.pathname, endpoint);
  const resource = await getJson(protectedUrl);
  assert.equal(resource.resource, endpoint.href, 'OAuth resource must match the MCP endpoint');
  assert(resource.authorization_servers?.length, 'Missing authorization server discovery');
  assert(scopes.every(scope => resource.scopes_supported?.includes(scope)), 'Missing required scopes');
  const issuer = new URL(resource.authorization_servers[0]);
  assert(issuer.protocol === 'https:', 'OAuth issuer must use HTTPS');
  const oauth = await getJson(new URL('/.well-known/oauth-authorization-server', issuer));
  assert.equal(oauth.issuer, issuer.href.replace(/\/$/, ''), 'Unexpected authorization server issuer');
  assert(oauth.code_challenge_methods_supported?.includes('S256'), 'PKCE S256 must be advertised');
  assert(oauth.registration_endpoint || oauth.client_id_metadata_document_supported,
    'Automatic OAuth client registration must be advertised');
  const unauthenticated = await fetch(endpoint, {
    method: 'POST', redirect: 'error', signal: AbortSignal.timeout(20000),
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 0, method: 'tools/list', params: {} }),
  });
  await unauthenticated.body?.cancel();
  assert.equal(unauthenticated.status, 401, 'Anonymous MCP requests must require sign-in');
  assert(unauthenticated.headers.get('www-authenticate')?.includes(protectedUrl.href),
    '401 must point to OAuth resource discovery');
  report.public = { oauthDiscovery: 'passed', pkceS256: 'passed', anonymousAccessDenied: 'passed' };

  if (token) {
    await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {},
      clientInfo: { name: 'replayio-release-preflight', version: '1.1.0' } });
    const tools = [];
    let cursor;
    for (let pages = 0; pages < 10; pages++) {
      const page = await rpc('tools/list', cursor ? { cursor } : {});
      tools.push(...page.tools);
      cursor = page.nextCursor;
      if (!cursor) break;
    }
    assert(!cursor, 'Unbounded tool listing');
    const overview = tools.find(tool => tool.name === 'RecordingOverview');
    const preview = tools.find(tool => tool.name === 'RecordingPreview');
    assert(overview && preview, 'Deploy the preview backend before release');
    assert.equal(overview._meta?.ui?.resourceUri, uiUri, 'Missing MCP UI resource reference');
    assert.equal(overview._meta?.['openai/outputTemplate'], uiUri, 'Missing OpenAI UI reference');
    assert.deepEqual(preview._meta?.ui?.visibility, ['app'], 'Preview must be app-only');
    assert.equal(preview._meta?.['openai/visibility'], 'private', 'Preview must not be model-visible');
    for (const tool of [overview, preview]) {
      assert(tool.inputSchema?.properties?.recordingId, 'Recording-scoped input is required');
      assert.equal(tool.annotations?.readOnlyHint, true, 'Debug tools must declare read-only behavior');
      assert(tool._meta?.securitySchemes?.some(scheme => scheme.type === 'oauth2'
        && scopes.every(scope => scheme.scopes?.includes(scope))), 'Missing OAuth tool metadata');
    }
    const resource = await rpc('resources/read', { uri: uiUri });
    const html = resource.contents?.find(item => item.uri === uiUri);
    assert.equal(html?.mimeType, 'text/html;profile=mcp-app', 'Incorrect MCP Apps MIME type');
    assert(html.text?.includes('<!doctype html>'), 'UI resource must contain HTML');
    const csp = html._meta?.ui?.csp;
    assert.deepEqual(csp?.connectDomains, [], 'Preview must load data through the authenticated host bridge');
    assert.deepEqual(csp?.resourceDomains, [], 'Preview must not reload arbitrary recorded-site resources');
    assert.deepEqual(html._meta?.['openai/widgetCSP']?.resource_domains, [], 'Legacy CSP must match');
    report.authenticated = { toolsAndUiResource: 'passed', browserRecording: 'not run',
      nodeRecording: 'not run', deniedRecording: 'not run' };

    if (values['recording-id']) {
      const recordingId = values['recording-id'];
      const overview = await callTool('RecordingOverview', recordingId);
      assert(!overview.isError, 'RecordingOverview returned a tool error');
      assert.equal(overview._meta?.[metaKey]?.recordingId, recordingId, 'Overview must initialize its own recording');
      let cursor = 0;
      let frames = 0;
      let skippedFrames = 0;
      for (let pageNumber = 0; pageNumber < 30; pageNumber++) {
        const page = previewPage(await callTool('RecordingPreview', recordingId, { cursor }));
        assert.equal(page.recordingId, recordingId, 'Preview must stay on the requested recording');
        assert(page.snapshotCount > 0 && page.snapshotCount <= 30, 'Browser fixture must have bounded frames');
        if (page.events.some(event => event.type === 2)) frames++;
        else {
          assert(page.warning, 'Skipped browser frames need an explanatory warning');
          skippedFrames++;
        }
        if (page.nextCursor === null) break;
        assert.equal(page.nextCursor, cursor + 1, 'Preview pagination must advance by one');
        assert(pageNumber < 29, 'Preview pagination exceeded 30 snapshots');
        cursor = page.nextCursor;
      }
      assert(frames > 0, 'Browser review fixture needs at least one renderable frame');
      report.authenticated.browserRecording = { result: 'passed', frames, skippedFrames };
    }
    if (values['node-recording-id']) {
      const page = previewPage(await callTool('RecordingPreview', values['node-recording-id'], { cursor: 0 }));
      assert.equal(page.events.length, 0, 'Node recording must not contain browser frames');
      assert.equal(page.nextCursor, null, 'Node recording must not paginate');
      assert(page.reason, 'Node recording needs an explanatory empty state');
      report.authenticated.nodeRecording = 'passed';
    }
    if (values['denied-recording-id']) {
      for (const name of ['RecordingOverview', 'RecordingPreview']) {
        const result = await callTool(name, values['denied-recording-id'], name === 'RecordingPreview' ? { cursor: 0 } : {});
        assert.equal(result.isError, true, 'Private recording must be denied by ' + name);
        assert(!result._meta?.[metaKey], 'Authorization failures must not expose preview data');
      }
      report.authenticated.deniedRecording = 'passed';
    }
  } else {
    assert(!values['recording-id'] && !values['node-recording-id'] && !values['denied-recording-id'],
      'Recording checks require REPLAYIO_MCP_TOKEN from the reviewer account');
  }
  console.log(JSON.stringify(report, null, 2));
} catch (error) {
  // JSON parse and transport errors can quote response bodies. Keep those out
  // of logs, and keep assertion diagnostics to their explicit summary line.
  const failure = error.name === 'AssertionError' ? error.message.split('\n')[0]
    : 'Server check failed (' + error.name + '); inspect the connection locally.';
  console.error(JSON.stringify({ ...report, failure }, null, 2));
  process.exitCode = 1;
}
