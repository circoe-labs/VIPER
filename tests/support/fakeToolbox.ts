// Faux serveur CIRCOE Toolbox local (tests Task 15 + smoke) : métadonnées OAuth (RFC 9728/8414), enregistrement dynamique, /authorize
// qui simule un utilisateur ayant tout accepté (redirection immédiate avec code/state/iss), /token (PKCE S256, `resource`, refresh
// optionnel) et endpoint MCP JSON-RPC (Streamable HTTP, JSON ou SSE) avec les outils mail simulés, mêmes formes et mêmes textes
// d'erreur que `circoe-toolbox` (commit 60ad176). Aucun appel réseau externe.
import http from 'node:http';
import { createHash } from 'node:crypto';
import type { AddressInfo } from 'node:net';

type Draft = { to: string[]; cc: string[]; bcc: string[]; subject: string; text: string };
export type FakeToolboxOptions = { refresh?: boolean; tokenTtlSec?: number; sse?: boolean; allowlist?: string[] };
export type FakeToolbox = {
  origin: string;
  mcpUrl: string;
  drafts: Map<string, Draft>;
  sent: string[];
  deleted: string[];
  calls: { method: string; tool?: string; auth: string | null }[];
  registrations: { client_name: unknown; redirect_uris: unknown }[];
  tokenRequests: { grant_type: string | null }[];
  /** Pannes à la demande. */
  mode: { hangTool?: string; httpStatus?: number; toolErrorText?: string; delayTool?: string; delayMs?: number };
  /** Invalide tous les jetons émis (membre archivé, secret Toolbox changé…). */
  revokeAll(): void;
  close(): Promise<void>;
};

const readBody = (req: http.IncomingMessage) => new Promise<string>((resolve, reject) => {
  const chunks: Buffer[] = [];
  req.on('data', c => chunks.push(Buffer.from(c)));
  req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
  req.on('error', reject);
});
const json = (res: http.ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) => {
  res.writeHead(status, { 'content-type': 'application/json', ...headers });
  res.end(JSON.stringify(body));
};

export async function startFakeToolbox(options: FakeToolboxOptions = {}): Promise<FakeToolbox> {
  let origin = '';
  let seq = 0;
  const clients = new Map<string, string[]>();
  const codes = new Map<string, { clientId: string; redirectUri: string; challenge: string; resource: string; scope: string }>();
  const accessTokens = new Map<string, number>();
  const refreshTokens = new Map<string, string>();
  const hanging = new Set<http.ServerResponse>();
  const ttl = options.tokenTtlSec ?? 3600;

  const issue = (clientId: string, scope: string) => {
    const access = `at-${++seq}-${Math.random().toString(36).slice(2)}`;
    accessTokens.set(access, Date.now() + ttl * 1000);
    const body: Record<string, unknown> = { access_token: access, token_type: 'Bearer', expires_in: ttl, scope };
    if (options.refresh) {
      const refresh = `rt-${++seq}`;
      refreshTokens.set(refresh, clientId);
      body.refresh_token = refresh;
    }
    return body;
  };

  const fake: FakeToolbox = {
    origin: '', mcpUrl: '', drafts: new Map(), sent: [], deleted: [], calls: [], registrations: [], tokenRequests: [], mode: {},
    revokeAll: () => accessTokens.clear(),
    close: () => new Promise(resolve => { for (const res of hanging) res.destroy(); server.close(() => resolve()); server.closeAllConnections?.(); })
  };

  const toolError = (text: string) => ({ isError: true, content: [{ type: 'text', text }] });
  const toolOk = (value: Record<string, unknown>) => ({ content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] });
  function runTool(name: string, args: Record<string, unknown>) {
    if (fake.mode.toolErrorText) return toolError(fake.mode.toolErrorText);
    switch (name) {
      case 'infomaniak.mail.create_draft': {
        const draft: Draft = {
          to: args.to as string[], cc: (args.cc as string[] | undefined) ?? [], bcc: (args.bcc as string[] | undefined) ?? [],
          subject: String(args.subject), text: String(args.text)
        };
        const all = [...draft.to, ...draft.cc, ...draft.bcc];
        const blocked = options.allowlist ? all.filter(a => !options.allowlist!.some(rule => rule.startsWith('@') ? a.endsWith(rule) : a === rule)) : [];
        if (blocked.length) return toolError(`Destinataire(s) refusé(s) par la liste d'envoi autorisée (INFOMANIAK_SEND_ALLOWLIST) : ${blocked.join(', ')}.`);
        const draftId = `draft-${++seq}`;
        fake.drafts.set(draftId, draft);
        return toolOk({ draftId, draftUid: seq, to: draft.to, cc: draft.cc, bcc: draft.bcc, subject: draft.subject, inReplyTo: null, hint: 'Brouillon enregistré.' });
      }
      case 'infomaniak.mail.send_draft': {
        const id = String(args.draftId);
        const draft = fake.drafts.get(id);
        if (!draft) return toolError(`Brouillon introuvable : ${id}`);
        fake.drafts.delete(id);
        fake.sent.push(id);
        return toolOk({ sent: true, pendingConfirmation: false, draftId: id, to: draft.to, cc: draft.cc, bcc: draft.bcc, subject: draft.subject, reason: 'Envoi du brouillon validé explicitement par l\'utilisateur.', provider: { transport: 'api', etop: null, cancelResource: null } });
      }
      case 'infomaniak.mail.delete_draft': {
        const id = String(args.draftId);
        if (!fake.drafts.delete(id)) return toolError('L\'API Infomaniak Mail a répondu 404 : {"result":"error"}');
        fake.deleted.push(id);
        return toolOk({ deleted: true, draftId: id });
      }
      case 'infomaniak.mail.list_drafts':
        return toolOk({ folder: 'Drafts', drafts: [...fake.drafts.entries()].slice(0, Number(args.limit ?? 20)).map(([draftId, d]) => ({ draftId, subject: d.subject, to: d.to, cc: d.cc, date: null, preview: '' })) });
      default:
        return null;
    }
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', origin);
    try {
      if (req.method === 'GET' && url.pathname === '/.well-known/oauth-protected-resource') {
        return json(res, 200, { resource: `${origin}/mcp`, authorization_servers: [origin], scopes_supported: ['mail', 'calendar', 'contacts'] });
      }
      if (req.method === 'GET' && url.pathname === '/.well-known/oauth-authorization-server') {
        return json(res, 200, {
          issuer: origin, authorization_endpoint: `${origin}/authorize`, token_endpoint: `${origin}/token`, registration_endpoint: `${origin}/register`,
          response_types_supported: ['code'], authorization_response_iss_parameter_supported: true,
          grant_types_supported: options.refresh ? ['authorization_code', 'refresh_token'] : ['authorization_code'],
          code_challenge_methods_supported: ['S256'], token_endpoint_auth_methods_supported: ['none'], scopes_supported: ['mail', 'calendar', 'contacts']
        });
      }
      if (req.method === 'POST' && url.pathname === '/register') {
        const body = JSON.parse(await readBody(req)) as { client_name?: unknown; redirect_uris?: unknown };
        fake.registrations.push({ client_name: body.client_name, redirect_uris: body.redirect_uris });
        const uris = Array.isArray(body.redirect_uris) ? body.redirect_uris.map(String) : [];
        if (!uris.length) return json(res, 400, { error: 'invalid_redirect_uri' });
        const clientId = `client-${++seq}`;
        clients.set(clientId, uris);
        return json(res, 201, { client_id: clientId, redirect_uris: uris, token_endpoint_auth_method: 'none' });
      }
      if (req.method === 'GET' && url.pathname === '/authorize') {
        const p = url.searchParams;
        const clientId = p.get('client_id') ?? '';
        const redirectUri = p.get('redirect_uri') ?? '';
        const ok = clients.get(clientId)?.includes(redirectUri) && p.get('response_type') === 'code' && p.get('code_challenge')
          && p.get('code_challenge_method') === 'S256' && p.get('resource') === `${origin}/mcp` && (p.get('scope') ?? '').split(' ').every(s => ['mail', 'calendar', 'contacts'].includes(s));
        if (!ok) return json(res, 400, { error: 'invalid_request' });
        const code = `code-${++seq}`;
        codes.set(code, { clientId, redirectUri, challenge: p.get('code_challenge')!, resource: p.get('resource')!, scope: p.get('scope') ?? 'mail' });
        const back = new URL(redirectUri);
        back.searchParams.set('code', code);
        if (p.get('state')) back.searchParams.set('state', p.get('state')!);
        back.searchParams.set('iss', origin);
        res.writeHead(302, { location: back.toString() });
        return res.end();
      }
      if (req.method === 'POST' && url.pathname === '/token') {
        const form = new URLSearchParams(await readBody(req));
        fake.tokenRequests.push({ grant_type: form.get('grant_type') });
        if (form.get('grant_type') === 'authorization_code') {
          const record = codes.get(form.get('code') ?? '');
          const verifier = form.get('code_verifier') ?? '';
          const challenge = createHash('sha256').update(verifier).digest('base64url');
          if (!record || record.clientId !== form.get('client_id') || record.redirectUri !== form.get('redirect_uri') || record.resource !== form.get('resource') || challenge !== record.challenge) {
            return json(res, 400, { error: 'invalid_grant' });
          }
          codes.delete(form.get('code')!);
          return json(res, 200, issue(record.clientId, record.scope));
        }
        if (form.get('grant_type') === 'refresh_token' && options.refresh) {
          const clientId = refreshTokens.get(form.get('refresh_token') ?? '');
          if (!clientId || clientId !== form.get('client_id')) return json(res, 400, { error: 'invalid_grant' });
          refreshTokens.delete(form.get('refresh_token')!);
          return json(res, 200, issue(clientId, 'mail'));
        }
        return json(res, 400, { error: 'unsupported_grant_type' });
      }
      if (req.method === 'POST' && url.pathname === '/mcp') {
        const auth = String(req.headers.authorization ?? '');
        const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
        const expires = accessTokens.get(token);
        const raw = await readBody(req);
        const message = JSON.parse(raw) as { id?: number; method: string; params?: { name?: string; arguments?: Record<string, unknown> } };
        fake.calls.push({ method: message.method, tool: message.params?.name, auth: token || null });
        if (!expires || expires <= Date.now()) {
          return json(res, 401, { error: 'authentication_required' }, { 'www-authenticate': `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource"` });
        }
        if (fake.mode.httpStatus) return json(res, fake.mode.httpStatus, { error: 'boom' });
        if (message.id === undefined) { res.writeHead(202); return res.end(); }
        let result: unknown;
        if (message.method === 'initialize') result = { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'fake-toolbox', version: '0' } };
        else if (message.method === 'tools/call') {
          const name = message.params?.name ?? '';
          if (fake.mode.hangTool === name) { hanging.add(res); return; }
          // Outil lent : exécuté après le délai même si le client a abandonné entre-temps (Toolbox qui envoie malgré la coupure).
          if (fake.mode.delayTool === name) await new Promise(resolve => setTimeout(resolve, fake.mode.delayMs ?? 1000));
          result = runTool(name, message.params?.arguments ?? {});
          if (result === null) return json(res, 200, { jsonrpc: '2.0', id: message.id, error: { code: -32602, message: `Tool ${name} not found` } });
        } else return json(res, 200, { jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Method not found' } });
        const payload = { jsonrpc: '2.0', id: message.id, result };
        if (options.sse) {
          res.writeHead(200, { 'content-type': 'text/event-stream' });
          return res.end(`event: message\ndata: ${JSON.stringify(payload)}\n\n`);
        }
        return json(res, 200, payload);
      }
      json(res, 404, { error: 'not_found' });
    } catch {
      json(res, 500, { error: 'fake_failure' });
    }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  fake.origin = origin;
  fake.mcpUrl = `${origin}/mcp`;
  return fake;
}
