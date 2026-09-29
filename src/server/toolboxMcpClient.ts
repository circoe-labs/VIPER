// Adapter CIRCOE Toolbox MCP (Task 15, docs/07 § CIRCOE Toolbox) : client MCP serveur minimal (JSON-RPC 2.0 sur Streamable HTTP,
// `fetch` natif, aucune dépendance) derrière l'interface injectable `MailToolbox` (tests : faux MailToolbox ou faux serveur MCP).
//
// Contrat Toolbox vérifié dans `circoe-labs/circoe-toolbox` (commit 60ad176, 2026-09-29, `packages/integrations/infomaniak/src/mail`) :
// - `infomaniak.mail.create_draft` { to: email[1..50], cc?: email[≤50], bcc?: email[≤50], subject: 1..500, text: 1..200000, html?, inReplyTo? }
//   -> { draftId, draftUid, to, cc, bcc, subject, inReplyTo, hint } ; n'envoie jamais ; AUCUN champ `from` : l'expéditeur est la boîte
//   Infomaniak par défaut du token API personnel associé à la connexion Toolbox (le `from_email` VIPER n'est pas transmis) ;
// - `infomaniak.mail.send_draft` { draftId } -> { sent: true, draftId, to, cc, bcc, subject, reason, provider: { transport, etop,
//   cancelResource } } ; pas d'identifiant de message envoyé (pas de Message-ID) ; seule la liste `INFOMANIAK_SEND_ALLOWLIST` s'applique
//   (la politique `INFOMANIAK_DIRECT_SEND_MAIL` ne concerne que `send`/`reply` : `send_draft` EST l'envoi après approbation humaine) ;
// - `infomaniak.mail.delete_draft` { draftId } -> { deleted: true, draftId } ; brouillon absent = erreur HTTP 404 Infomaniak ;
// - `infomaniak.mail.list_drafts` { limit 1..100 } -> { folder, drafts: [{ draftId, subject, to, cc, date, preview }] } ;
// - erreurs d'outil : `result.isError` + texte français (le code `TOOLBOX_OUTBOUND_BLOCKED`, `INFOMANIAK_MAIL_HTTP_404`… n'est pas
//   transmis par le SDK MCP) => classement par motif ci-dessous ; le texte peut contenir des adresses : jamais journalisé ni stocké.
// Serveur MCP sans état (`createMcpHandler`, réponses JSON) : chaque opération fait `initialize` -> `notifications/initialized` ->
// `tools/call` (conforme aussi à un serveur avec session `mcp-session-id`). Jeton OAuth fourni par `ToolboxTokenProvider`
// (toolboxAuth.ts) ; un 401 déclenche une seule tentative de rafraîchissement puis `toolbox_auth_required`.
import { z } from 'zod';

export const toolboxErrorStatus = {
  toolbox_not_configured: 503,
  toolbox_auth_required: 409,
  toolbox_unavailable: 502,
  toolbox_timeout: 504,
  toolbox_rejected: 422,
  toolbox_outbound_blocked: 422,
  toolbox_invalid_input: 422,
  toolbox_draft_not_found: 404,
  toolbox_invalid_response: 502
} as const;
export type ToolboxErrorCode = keyof typeof toolboxErrorStatus;
/** Erreurs rejouables sans risque (hors `send_draft` en timeout : issue inconnue, voir `outcomeUnknown`). */
const retryableCodes: ToolboxErrorCode[] = ['toolbox_unavailable', 'toolbox_timeout'];
export class ToolboxError extends Error {
  readonly code: ToolboxErrorCode;
  readonly httpStatus: number;
  readonly retryable: boolean;
  /** Vrai si la requête a pu être exécutée côté Toolbox sans réponse (timeout/coupure pendant `send_draft`) : ne jamais rejouer à l'aveugle. */
  readonly outcomeUnknown: boolean;
  /** Diagnostic non sensible (statut HTTP amont, code JSON-RPC). Jamais de texte amont. */
  readonly upstreamStatus?: number;
  constructor(code: ToolboxErrorCode, message: string, extra: { upstreamStatus?: number; outcomeUnknown?: boolean } = {}) {
    super(message);
    this.name = 'ToolboxError';
    this.code = code;
    this.httpStatus = toolboxErrorStatus[code];
    this.retryable = retryableCodes.includes(code);
    this.outcomeUnknown = Boolean(extra.outcomeUnknown);
    if (extra.upstreamStatus !== undefined) this.upstreamStatus = extra.upstreamStatus;
  }
}

// --- Interface injectable ---
export type ToolboxDraftInput = { to: string[]; cc?: string[]; bcc?: string[]; subject: string; text: string };
export type ToolboxDraftSummary = { draftId: string; subject: string; date: string | null };
export type ToolboxSendResult = { draftId: string; transport: string | null; etop: unknown; cancelResource: string | null };
export type MailToolbox = {
  createDraft(input: ToolboxDraftInput): Promise<{ draftId: string }>;
  /** Envoi réel d'un brouillon validé (Task 16 uniquement, après verrou de dispatch). */
  sendDraft(draftId: string): Promise<ToolboxSendResult>;
  /** Idempotent : un brouillon déjà absent renvoie `{ deleted: false }` au lieu d'une erreur. */
  deleteDraft(draftId: string): Promise<{ deleted: boolean }>;
  /** Réconciliation (Task 16) : brouillons présents (id, objet, date ; destinataires non exposés). */
  listDrafts(limit?: number): Promise<ToolboxDraftSummary[]>;
};

/** Source du jeton d'accès MCP (toolboxAuth.ts). `null` = aucune connexion utilisable. */
export type ToolboxTokenProvider = {
  accessToken(): Promise<string | null>;
  /** Appelé sur 401 : tente un rafraîchissement ; renvoie le nouveau jeton ou `null` (reconnexion requise). */
  refreshAfterUnauthorized(rejected: string): Promise<string | null>;
};

export const TOOLBOX_TOOLS = {
  createDraft: 'infomaniak.mail.create_draft',
  sendDraft: 'infomaniak.mail.send_draft',
  deleteDraft: 'infomaniak.mail.delete_draft',
  listDrafts: 'infomaniak.mail.list_drafts'
} as const;
export const MCP_PROTOCOL_VERSION = '2025-06-18';

// --- Validation locale (bornes du schéma Toolbox) : refus clair avant tout appel réseau ---
const email = z.string().trim().pipe(z.email());
const draftInputSchema = z.object({
  to: z.array(email).min(1).max(50),
  cc: z.array(email).max(50).optional(),
  bcc: z.array(email).max(50).optional(),
  subject: z.string().min(1).max(500),
  text: z.string().min(1).max(200_000)
});
const draftIdSchema = z.string().trim().min(1).max(200);

// --- Sorties attendues ---
const createDraftOutput = z.object({ draftId: z.string().min(1) }).passthrough();
const sendDraftOutput = z.object({
  sent: z.literal(true), draftId: z.string().nullable().optional(),
  provider: z.object({ transport: z.string().nullable().optional(), etop: z.unknown().optional(), cancelResource: z.string().nullable().optional() }).passthrough().optional()
}).passthrough();
const deleteDraftOutput = z.object({ deleted: z.boolean() }).passthrough();
const listDraftsOutput = z.object({
  drafts: z.array(z.object({ draftId: z.string().nullable(), subject: z.string().optional(), date: z.string().nullable().optional() }).passthrough())
}).passthrough();

/** Classement d'un texte d'erreur d'outil Toolbox (français) ; le texte lui-même n'est jamais conservé. */
export function classifyToolError(text: string): ToolboxErrorCode {
  if (/INFOMANIAK_SEND_ALLOWLIST|liste d'envoi autoris|TOOLBOX_OUTBOUND_BLOCKED/i.test(text)) return 'toolbox_outbound_blocked';
  if (/Brouillon introuvable|MAIL_DRAFT_NOT_FOUND|a répondu 404/i.test(text)) return 'toolbox_draft_not_found';
  if (/Aucune connexion Infomaniak|a répondu 401|a répondu 403|token API personnel/i.test(text)) return 'toolbox_auth_required';
  if (/a répondu (5\d\d|429)|ETIMEDOUT|ECONNRESET|fetch failed/i.test(text)) return 'toolbox_unavailable';
  if (/Paramètres invalides|TOOL_INPUT_INVALID/i.test(text)) return 'toolbox_invalid_input';
  return 'toolbox_rejected';
}

export type McpMailToolboxOptions = {
  mcpUrl: string;
  tokens: ToolboxTokenProvider;
  timeoutMs?: number;
  fetch?: typeof fetch;
  clientName?: string;
};

type JsonRpcResponse = { jsonrpc?: string; id?: number | string | null; result?: unknown; error?: { code?: number; message?: string } };
const callResultSchema = z.object({
  isError: z.boolean().optional(),
  structuredContent: z.record(z.string(), z.unknown()).optional(),
  content: z.array(z.object({ type: z.string(), text: z.string().optional() }).passthrough()).optional()
}).passthrough();

/** Réponse JSON ou flux SSE (`data:` par événement) : renvoie le message JSON-RPC portant `id`. */
function parseRpcBody(text: string, contentType: string, id: number): JsonRpcResponse | undefined {
  if (!contentType.includes('text/event-stream')) {
    const parsed = JSON.parse(text) as JsonRpcResponse | JsonRpcResponse[];
    return Array.isArray(parsed) ? parsed.find(m => m.id === id) : parsed;
  }
  for (const block of text.split(/\r?\n\r?\n/)) {
    const data = block.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
    if (!data) continue;
    const message = JSON.parse(data) as JsonRpcResponse;
    if (message.id === id) return message;
  }
  return undefined;
}

export function createMcpMailToolbox(options: McpMailToolboxOptions): MailToolbox {
  const doFetch = options.fetch ?? fetch;
  const timeoutMs = options.timeoutMs ?? 20_000;
  const clientName = options.clientName ?? 'VIPER';
  let nextId = 1;

  type Session = { token: string; sessionId?: string; protocolVersion: string };
  async function post(session: Session, body: unknown, signal: AbortSignal, sensitive: boolean): Promise<{ status: number; text: string; contentType: string; sessionId: string | null }> {
    const headers: Record<string, string> = {
      authorization: `Bearer ${session.token}`,
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      'mcp-protocol-version': session.protocolVersion
    };
    if (session.sessionId) headers['mcp-session-id'] = session.sessionId;
    let response: Response;
    try {
      response = await doFetch(options.mcpUrl, { method: 'POST', headers, body: JSON.stringify(body), signal });
    } catch {
      if (signal.aborted) throw new ToolboxError('toolbox_timeout', 'La Toolbox n’a pas répondu à temps', { outcomeUnknown: sensitive });
      throw new ToolboxError('toolbox_unavailable', 'Toolbox injoignable', { outcomeUnknown: sensitive });
    }
    let text: string;
    try {
      text = await response.text();
    } catch {
      if (signal.aborted) throw new ToolboxError('toolbox_timeout', 'La Toolbox n’a pas répondu à temps', { outcomeUnknown: sensitive });
      throw new ToolboxError('toolbox_unavailable', 'Réponse Toolbox interrompue', { outcomeUnknown: sensitive });
    }
    return { status: response.status, text, contentType: response.headers.get('content-type') ?? '', sessionId: response.headers.get('mcp-session-id') };
  }

  async function rpc(session: Session, method: string, params: Record<string, unknown>, signal: AbortSignal, sensitive = false): Promise<{ result: unknown; sessionId: string | null }> {
    const id = nextId++;
    const res = await post(session, { jsonrpc: '2.0', id, method, params }, signal, sensitive);
    if (res.status === 401 || res.status === 403) throw new ToolboxError('toolbox_auth_required', 'Connexion Toolbox expirée ou refusée : reconnecter la Toolbox', { upstreamStatus: res.status });
    if (res.status >= 500 || res.status === 429 || res.status === 408) throw new ToolboxError('toolbox_unavailable', 'Toolbox indisponible', { upstreamStatus: res.status, outcomeUnknown: sensitive && res.status >= 500 });
    if (res.status < 200 || res.status >= 300) throw new ToolboxError('toolbox_rejected', 'Requête refusée par la Toolbox', { upstreamStatus: res.status });
    let message: JsonRpcResponse | undefined;
    try { message = parseRpcBody(res.text, res.contentType, id); } catch { message = undefined; }
    if (!message) throw new ToolboxError('toolbox_invalid_response', 'Réponse Toolbox illisible', { upstreamStatus: res.status });
    if (message.error) throw new ToolboxError(/not found/i.test(String(message.error.message ?? '')) ? 'toolbox_rejected' : 'toolbox_invalid_response',
      `Erreur MCP ${message.error.code ?? ''}`.trim(), { upstreamStatus: res.status });
    return { result: message.result, sessionId: res.sessionId };
  }

  async function notify(session: Session, method: string, signal: AbortSignal) {
    const res = await post(session, { jsonrpc: '2.0', method }, signal, false);
    if (res.status === 401 || res.status === 403) throw new ToolboxError('toolbox_auth_required', 'Connexion Toolbox expirée ou refusée : reconnecter la Toolbox', { upstreamStatus: res.status });
  }

  async function callOnce(token: string, tool: string, args: Record<string, unknown>, signal: AbortSignal, sensitive: boolean) {
    const session: Session = { token, protocolVersion: MCP_PROTOCOL_VERSION };
    const init = await rpc(session, 'initialize', {
      protocolVersion: MCP_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: clientName, version: '1.0.0' }
    }, signal);
    const negotiated = z.object({ protocolVersion: z.string() }).passthrough().safeParse(init.result);
    if (negotiated.success) session.protocolVersion = negotiated.data.protocolVersion;
    if (init.sessionId) session.sessionId = init.sessionId;
    await notify(session, 'notifications/initialized', signal);
    return (await rpc(session, 'tools/call', { name: tool, arguments: args }, signal, sensitive)).result;
  }

  /** Appel d'outil : délai global par opération, un seul rafraîchissement du jeton sur 401. */
  async function callTool(tool: string, args: Record<string, unknown>, sensitive = false): Promise<Record<string, unknown>> {
    let token = await options.tokens.accessToken();
    if (!token) throw new ToolboxError('toolbox_auth_required', 'Toolbox non connectée : connecter la Toolbox depuis les Paramètres');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      let raw: unknown;
      try {
        raw = await callOnce(token, tool, args, controller.signal, sensitive);
      } catch (e) {
        if (!(e instanceof ToolboxError) || e.code !== 'toolbox_auth_required' || e.upstreamStatus === undefined) throw e;
        token = await options.tokens.refreshAfterUnauthorized(token);
        if (!token) throw e;
        raw = await callOnce(token, tool, args, controller.signal, sensitive);
      }
      const parsed = callResultSchema.safeParse(raw);
      if (!parsed.success) throw new ToolboxError('toolbox_invalid_response', 'Résultat d’outil Toolbox illisible');
      const text = (parsed.data.content ?? []).map(part => part.text ?? '').join('\n');
      if (parsed.data.isError) {
        const code = classifyToolError(text);
        throw new ToolboxError(code, `La Toolbox a refusé l’opération (${code})`, { outcomeUnknown: sensitive && code === 'toolbox_unavailable' });
      }
      if (parsed.data.structuredContent) return parsed.data.structuredContent;
      try {
        const json = JSON.parse(text) as unknown;
        if (json && typeof json === 'object' && !Array.isArray(json)) return json as Record<string, unknown>;
      } catch { /* classé ci-dessous */ }
      throw new ToolboxError('toolbox_invalid_response', 'Résultat d’outil Toolbox non JSON');
    } finally {
      clearTimeout(timer);
    }
  }

  const output = <T>(schema: z.ZodType<T>, value: unknown): T => {
    const parsed = schema.safeParse(value);
    if (!parsed.success) throw new ToolboxError('toolbox_invalid_response', 'Résultat d’outil Toolbox inattendu');
    return parsed.data;
  };
  const draftId = (value: string) => {
    const parsed = draftIdSchema.safeParse(value);
    if (!parsed.success) throw new ToolboxError('toolbox_invalid_input', 'Identifiant de brouillon distant invalide');
    return parsed.data;
  };

  return {
    async createDraft(input) {
      const parsed = draftInputSchema.safeParse({
        to: input.to, subject: input.subject, text: input.text,
        ...(input.cc?.length ? { cc: input.cc } : {}), ...(input.bcc?.length ? { bcc: input.bcc } : {})
      });
      if (!parsed.success) throw new ToolboxError('toolbox_invalid_input', `Brouillon refusé avant envoi à la Toolbox (champ ${String(parsed.error.issues[0]?.path[0] ?? '?')})`);
      const result = output(createDraftOutput, await callTool(TOOLBOX_TOOLS.createDraft, parsed.data));
      return { draftId: result.draftId };
    },
    async sendDraft(id) {
      const result = output(sendDraftOutput, await callTool(TOOLBOX_TOOLS.sendDraft, { draftId: draftId(id) }, true));
      return {
        draftId: result.draftId ?? id, transport: result.provider?.transport ?? null,
        etop: result.provider?.etop ?? null, cancelResource: result.provider?.cancelResource ?? null
      };
    },
    async deleteDraft(id) {
      try {
        return { deleted: output(deleteDraftOutput, await callTool(TOOLBOX_TOOLS.deleteDraft, { draftId: draftId(id) })).deleted };
      } catch (e) {
        if (e instanceof ToolboxError && e.code === 'toolbox_draft_not_found') return { deleted: false };
        throw e;
      }
    },
    async listDrafts(limit = 100) {
      const result = output(listDraftsOutput, await callTool(TOOLBOX_TOOLS.listDrafts, { limit: Math.min(100, Math.max(1, Math.trunc(limit))) }));
      return result.drafts.filter(d => d.draftId).map(d => ({ draftId: String(d.draftId), subject: d.subject ?? '', date: d.date ?? null }));
    }
  };
}
