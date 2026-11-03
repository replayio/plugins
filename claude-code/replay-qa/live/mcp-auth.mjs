// The Replay QA MCP sign-in, as the relay holds it. A credential is what the MCP server's
// `create_cli_credential` tool mints: `mcl_` + base64url of `{ u: qa origin, i: client_id, c: code,
// v: code_verifier, r: redirect_uri }`, opaque, single-use and short-lived. It is exchanged at the QA
// server's OAuth endpoint for an hour-long `mcp_` token and a rotating refresh token.
//
// Errors here never hold a credential or a token: they reach the pane and the debug log.

/** Reads a credential; throws, without echoing it, when it is not one or names a server not to be trusted with it. */
export function decodeCredential(credential) {
  if (typeof credential !== 'string' || !credential.startsWith('mcl_')) throw new Error('That is not a Replay QA CLI credential.')
  let fields
  try {
    fields = JSON.parse(Buffer.from(credential.slice(4), 'base64url').toString('utf8'))
  } catch {
    throw new Error('The Replay QA CLI credential could not be read.')
  }
  if (!fields || [fields.u, fields.i, fields.c, fields.v, fields.r].some(field => typeof field !== 'string' || !field)) {
    throw new Error('The Replay QA CLI credential is missing a field.')
  }
  let url
  try {
    url = new URL(fields.u)
  } catch {
    throw new Error('The Replay QA CLI credential names no QA server.')
  }
  const isLoopback = /^(?:localhost|127\.0\.0\.1|\[::1\])$/.test(url.hostname)
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && isLoopback)) {
    throw new Error(`The Replay QA CLI credential names an insecure QA server: ${url.host}.`)
  }
  return { origin: url.origin, clientId: fields.i, code: fields.c, verifier: fields.v, redirectUri: fields.r }
}

async function postToken(origin, params) {
  const response = await fetch(`${origin}/api/oauth-token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params).toString(),
    signal: AbortSignal.timeout(30_000),
  })
  const data = await response.json().catch(() => ({}))
  if (!response.ok || typeof data.access_token !== 'string') {
    const error = new Error(`Replay QA on ${new URL(origin).host} refused the token request (${response.status}${typeof data.error === 'string' ? `: ${data.error}` : ''}).`)
    error.status = response.status
    throw error
  }
  return {
    accessToken: data.access_token,
    refreshToken: typeof data.refresh_token === 'string' ? data.refresh_token : '',
    expiresAt: Date.now() + (Number(data.expires_in) || 3600) * 1000,
  }
}

/** Exchanges a credential, once: `{ origin, clientId, accessToken, refreshToken, expiresAt }`. */
export async function exchangeCredential(credential) {
  const { origin, clientId, code, verifier, redirectUri } = decodeCredential(credential)
  const tokens = await postToken(origin, {
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri,
    client_id: clientId,
    code_verifier: verifier,
  })
  return { origin, clientId, ...tokens }
}

/** The session's next tokens. Refresh tokens rotate: this spends the session's current one. */
export async function refreshSession(session) {
  const tokens = await postToken(session.origin, {
    grant_type: 'refresh_token',
    refresh_token: session.refreshToken,
    client_id: session.clientId,
  })
  return { ...session, ...tokens }
}

/**
 * A new credential for one process, from the server's own MCP endpoint, on an access token of a session
 * a credential gave. The relay does this rather than the hooks module: the engine puts the module's
 * `$.mcp.call` to the session's permission mode, and only a call from a hook can be allowed, so one from a
 * button, a timer or a browser press would stop to ask the person. Null when the server gives none.
 */
export async function mintWithToken(origin, accessToken) {
  const response = await fetch(`${origin}/api/mcp`, {
    method: 'POST',
    headers: { authorization: `Bearer ${accessToken}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'create_cli_credential', arguments: {} } }),
    signal: AbortSignal.timeout(20_000),
  })
  if (response.status === 401) {
    const error = new Error('The token was refused.')
    error.status = 401
    throw error
  }
  const data = await response.json().catch(() => null)
  const text = data?.result?.isError ? null : data?.result?.content?.find(block => block.type === 'text')?.text
  if (!text) return null
  try {
    const { credential } = JSON.parse(text)
    decodeCredential(credential)
    return credential
  } catch {
    return null
  }
}
