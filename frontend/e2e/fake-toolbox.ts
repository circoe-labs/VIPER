// A local stand-in for the CIRCOE Toolbox (Contact port P6: no real call to the Toolbox or Infomaniak, ever). Started by
// playwright.config.ts as a web server; the E2E backend points VIPER_TOOLBOX_MCP_URL at it. Port of the reference fake
// (root tests/support/fakeToolbox.ts, same shapes and French error texts as circoe-toolbox commit 60ad176):
//
// - OAuth: RFC 9728/8414 metadata, dynamic registration, `/authorize` acting as a person who accepts everything (an
//   immediate redirect to the redirect URI with `code`, `state`, `iss`), `/token` (PKCE S256 checked, 30-day token);
// - MCP (`POST /mcp`, JSON-RPC): initialize, notifications, tools/call for create/send/delete/list drafts; a 401 on an
//   unknown token;
// - test controls: `GET /drafts` (draft ids and subjects held, the ids deleted), `POST /mode` `{toolErrorText}` (every
//   tool call fails with that text; `{}` resets), `GET /health` (readiness). Synthetic values only; tokens never logged.
import { createHash, randomBytes } from 'node:crypto'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'

const port = Number(process.env.VIPER_E2E_TOOLBOX_PORT ?? 8047)
const origin = `http://127.0.0.1:${String(port)}`
const mcpUrl = `${origin}/mcp`
const TOKEN_TTL_S = 30 * 24 * 3600

interface Draft {
  to: string[]
  cc: string[]
  bcc: string[]
  subject: string
  text: string
}

let seq = 0
const clients = new Map<string, string[]>()
const codes = new Map<string, { clientId: string; redirectUri: string; challenge: string; resource: string; scope: string }>()
const tokens = new Map<string, number>()
const drafts = new Map<string, Draft>()
const deleted: string[] = []
const sent: string[] = []
const mode: { toolErrorText?: string } = {}

// Answers JSON; returns the response so a handler can `return send(…)`.
function send(response: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): ServerResponse {
  const text = JSON.stringify(body)
  response.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(text), ...headers })
  return response.end(text)
}

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of request) chunks.push(chunk as Buffer)
  return Buffer.concat(chunks).toString('utf8')
}

const toolError = (text: string) => ({ isError: true, content: [{ type: 'text', text }] })
const toolOk = (value: Record<string, unknown>) => ({ content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] })

function runTool(name: string, args: Record<string, unknown>): unknown {
  if (mode.toolErrorText) return toolError(mode.toolErrorText)
  switch (name) {
    case 'infomaniak.mail.create_draft': {
      const draft: Draft = {
        to: args.to as string[],
        cc: (args.cc as string[] | undefined) ?? [],
        bcc: (args.bcc as string[] | undefined) ?? [],
        subject: String(args.subject),
        text: String(args.text),
      }
      seq += 1
      const draftId = `draft-${String(seq)}`
      drafts.set(draftId, draft)
      return toolOk({ draftId, draftUid: seq, to: draft.to, cc: draft.cc, bcc: draft.bcc, subject: draft.subject, inReplyTo: null, hint: 'Brouillon enregistré.' })
    }
    case 'infomaniak.mail.send_draft': {
      const id = String(args.draftId)
      const draft = drafts.get(id)
      if (!draft) return toolError(`Brouillon introuvable : ${id}`)
      drafts.delete(id)
      sent.push(id)
      return toolOk({ sent: true, pendingConfirmation: false, draftId: id, to: draft.to, subject: draft.subject, provider: { transport: 'api', etop: null, cancelResource: null } })
    }
    case 'infomaniak.mail.delete_draft': {
      const id = String(args.draftId)
      if (!drafts.delete(id)) return toolError('L\'API Infomaniak Mail a répondu 404 : {"result":"error"}')
      deleted.push(id)
      return toolOk({ deleted: true, draftId: id })
    }
    case 'infomaniak.mail.list_drafts':
      return toolOk({
        folder: 'Drafts',
        drafts: [...drafts.entries()].slice(0, Number(args.limit ?? 20)).map(([draftId, d]) => ({ draftId, subject: d.subject, to: d.to, date: null })),
      })
    default:
      return null
  }
}

async function answer(request: IncomingMessage, response: ServerResponse) {
  const url = new URL(request.url ?? '/', origin)
  const path = url.pathname
  if (request.method === 'GET' && path === '/health') return send(response, 200, { ok: true })
  if (request.method === 'GET' && path === '/drafts') {
    return send(response, 200, { drafts: [...drafts.entries()].map(([id, d]) => ({ id, subject: d.subject, to: d.to })), deleted, sent })
  }
  if (request.method === 'POST' && path === '/mode') {
    const body = JSON.parse((await readBody(request)) || '{}') as { toolErrorText?: string }
    mode.toolErrorText = body.toolErrorText
    return send(response, 200, mode)
  }
  if (request.method === 'GET' && path === '/.well-known/oauth-protected-resource') {
    return send(response, 200, { resource: mcpUrl, authorization_servers: [origin], scopes_supported: ['mail'] })
  }
  if (request.method === 'GET' && path === '/.well-known/oauth-authorization-server') {
    return send(response, 200, {
      issuer: origin,
      authorization_endpoint: `${origin}/authorize`,
      token_endpoint: `${origin}/token`,
      registration_endpoint: `${origin}/register`,
      response_types_supported: ['code'],
      authorization_response_iss_parameter_supported: true,
      grant_types_supported: ['authorization_code'],
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['none'],
      scopes_supported: ['mail'],
    })
  }
  if (request.method === 'POST' && path === '/register') {
    const body = JSON.parse(await readBody(request)) as { redirect_uris?: unknown }
    const uris = Array.isArray(body.redirect_uris) ? body.redirect_uris.map(String) : []
    if (uris.length === 0) return send(response, 400, { error: 'invalid_redirect_uri' })
    seq += 1
    const clientId = `client-${String(seq)}`
    clients.set(clientId, uris)
    return send(response, 201, { client_id: clientId, redirect_uris: uris, token_endpoint_auth_method: 'none' })
  }
  if (request.method === 'GET' && path === '/authorize') {
    const p = url.searchParams
    const clientId = p.get('client_id') ?? ''
    const redirectUri = p.get('redirect_uri') ?? ''
    const ok =
      clients.get(clientId)?.includes(redirectUri) &&
      p.get('response_type') === 'code' &&
      p.get('code_challenge') &&
      p.get('code_challenge_method') === 'S256' &&
      p.get('resource') === mcpUrl
    if (!ok) return send(response, 400, { error: 'invalid_request' })
    seq += 1
    const code = `code-${String(seq)}`
    codes.set(code, { clientId, redirectUri, challenge: p.get('code_challenge') ?? '', resource: mcpUrl, scope: p.get('scope') ?? 'mail' })
    const back = new URL(redirectUri)
    back.searchParams.set('code', code)
    const state = p.get('state')
    if (state) back.searchParams.set('state', state)
    back.searchParams.set('iss', origin)
    response.writeHead(302, { location: back.toString() })
    return response.end()
  }
  if (request.method === 'POST' && path === '/token') {
    const form = new URLSearchParams(await readBody(request))
    const record = codes.get(form.get('code') ?? '')
    const challenge = createHash('sha256').update(form.get('code_verifier') ?? '').digest('base64url')
    if (
      form.get('grant_type') !== 'authorization_code' ||
      !record ||
      record.clientId !== form.get('client_id') ||
      record.redirectUri !== form.get('redirect_uri') ||
      record.resource !== form.get('resource') ||
      record.challenge !== challenge
    ) {
      return send(response, 400, { error: 'invalid_grant' })
    }
    codes.delete(form.get('code') ?? '')
    const access = `at-${randomBytes(12).toString('hex')}`
    tokens.set(access, Date.now() + TOKEN_TTL_S * 1000)
    return send(response, 200, { access_token: access, token_type: 'Bearer', expires_in: TOKEN_TTL_S, scope: record.scope })
  }
  if (request.method === 'POST' && path === '/mcp') {
    const auth = request.headers.authorization ?? ''
    const token = auth.startsWith('Bearer ') ? auth.slice(7) : ''
    const message = JSON.parse(await readBody(request)) as { id?: number; method: string; params?: { name?: string; arguments?: Record<string, unknown> } }
    const expires = tokens.get(token)
    if (!expires || expires <= Date.now()) return send(response, 401, { error: 'authentication_required' })
    if (message.id === undefined) {
      response.writeHead(202)
      return response.end()
    }
    let result: unknown
    if (message.method === 'initialize') {
      result = { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'fake-toolbox', version: '0' } }
    } else if (message.method === 'tools/call') {
      const name = message.params?.name ?? ''
      result = runTool(name, message.params?.arguments ?? {})
      if (result === null) return send(response, 200, { jsonrpc: '2.0', id: message.id, error: { code: -32602, message: `Tool ${name} not found` } })
    } else {
      return send(response, 200, { jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Method not found' } })
    }
    return send(response, 200, { jsonrpc: '2.0', id: message.id, result })
  }
  return send(response, 404, { error: 'not_found' })
}

const server = createServer((request, response) => {
  answer(request, response).catch((error: unknown) => {
    // Visible in the Playwright output: a fake that fails must not look like a slow Toolbox.
    console.error('fake Toolbox failed:', error)
    send(response, 500, { error: 'fake_failure' })
  })
})

server.listen(port, '127.0.0.1', () => {
  console.log(`fake CIRCOE Toolbox listening on ${mcpUrl}`)
})
