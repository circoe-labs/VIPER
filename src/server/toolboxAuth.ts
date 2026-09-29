// Connexion VIPER -> CIRCOE Toolbox MCP (Task 15, docs/08 §5) : client OAuth 2.1 Authorization Code + PKCE (S256), le mécanisme
// officiellement exposé par la Toolbox à tout client MCP (`apps/server/src/oauth.ts`, découverte vérifiée en production le 2026-09-29) :
// - découverte RFC 9728 `/.well-known/oauth-protected-resource` (ressource = URL MCP exacte, `authorization_servers`) puis RFC 8414
//   `/.well-known/oauth-authorization-server` ; S256 exigé ;
// - enregistrement dynamique RFC 7591 (`/register`, client public `token_endpoint_auth_method=none`, `client_id` scellé sans état côté
//   Toolbox) ; conservé et réutilisé tant que l'émetteur et l'URI de redirection ne changent pas ;
// - `/authorize` avec `resource` (RFC 8707, obligatoire : URL MCP exacte), `scope=mail` (moindre privilège, ADR 0005 Toolbox), `state`
//   à usage unique lié à l'utilisateur VIPER qui a cliqué ; la Toolbox fait se connecter l'utilisateur chez Infomaniak (OIDC) puis lui
//   fait coller un token API Infomaniak personnel (Mail) ; retour sur `redirect_uri` avec `code`, `state`, `iss` (RFC 9207, vérifié) ;
// - `/token` (`authorization_code` + `code_verifier` + `resource`) -> jeton Bearer opaque (session scellée Toolbox, 30 jours).
//   La Toolbox n'émet AUCUN refresh token (`grant_types_supported: ["authorization_code"]`) : à expiration ou sur 401 (membre archivé,
//   secret Toolbox changé), l'état passe à « à reconnecter ». Le rafraîchissement standard (`refresh_token`) est pris en charge si un
//   serveur en fournit un (tests), jamais supposé.
// Stockage : fichier JSON serveur (0600, dossier 0700) hors du dépôt et hors base SQLite (la base est exportable vers le navigateur :
// `/api/state/backup`, `/api/database/*`) ; aucun jeton dans les réponses API, les logs ou le client.
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { z } from 'zod';
import type { Actor } from './audit.js';
import { ToolboxError, type ToolboxTokenProvider } from './toolboxMcpClient.js';

export type ToolboxAuthConfig = {
  mcpUrl: string;
  redirectUri: string;
  tokenStorePath: string;
  scope?: string;
  timeoutMs?: number;
  clientName?: string;
};

// --- Stockage ---
export type StoredToolboxClient = { issuer: string; clientId: string; redirectUri: string; registeredAt: string };
export type StoredToolboxToken = {
  accessToken: string; refreshToken: string | null; expiresAt: string | null; scope: string;
  issuer: string; resource: string; tokenEndpoint: string; clientId: string; refreshSupported: boolean;
  obtainedAt: string; invalidatedAt: string | null;
};
export type ToolboxStoreFile = {
  version: 1;
  client?: StoredToolboxClient;
  token?: StoredToolboxToken;
  connectedBy?: { id: string | null; display: string | null };
  connectedAt?: string;
};
export type ToolboxTokenStore = { read(): ToolboxStoreFile; write(file: ToolboxStoreFile): void };

export function createMemoryTokenStore(initial: ToolboxStoreFile = { version: 1 }): ToolboxTokenStore & { snapshot(): ToolboxStoreFile } {
  let file = structuredClone(initial);
  return { read: () => structuredClone(file), write: next => { file = structuredClone(next); }, snapshot: () => structuredClone(file) };
}
/** Fichier privé, écriture atomique (fichier temporaire + rename). Contenu illisible = aucune connexion (jamais d'exception au démarrage). */
export function createFileTokenStore(filePath: string): ToolboxTokenStore {
  return {
    read() {
      try {
        const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8')) as ToolboxStoreFile;
        return parsed && parsed.version === 1 ? parsed : { version: 1 };
      } catch { return { version: 1 }; }
    },
    write(file) {
      fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
      const tmp = `${filePath}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(file), { mode: 0o600 });
      fs.renameSync(tmp, filePath);
      try { fs.chmodSync(filePath, 0o600); } catch { /* Windows : ACL du profil utilisateur */ }
    }
  };
}

// --- Métadonnées ---
const protectedResourceSchema = z.object({ resource: z.string(), authorization_servers: z.array(z.string()).min(1) }).passthrough();
const authorizationServerSchema = z.object({
  issuer: z.string(), authorization_endpoint: z.string(), token_endpoint: z.string(),
  registration_endpoint: z.string().optional(),
  code_challenge_methods_supported: z.array(z.string()).optional(),
  grant_types_supported: z.array(z.string()).optional(),
  authorization_response_iss_parameter_supported: z.boolean().optional()
}).passthrough();
const registrationSchema = z.object({ client_id: z.string().min(1) }).passthrough();
const tokenSchema = z.object({
  access_token: z.string().min(1), token_type: z.string().optional(), expires_in: z.number().positive().optional(),
  refresh_token: z.string().min(1).optional(), scope: z.string().optional()
}).passthrough();
type AuthorizationServer = z.infer<typeof authorizationServerSchema>;
export type ToolboxDiscovery = { resource: string; server: AuthorizationServer };

const sameUrl = (a: string, b: string) => {
  try { return new URL(a).href.replace(/\/+$/, '') === new URL(b).href.replace(/\/+$/, ''); } catch { return false; }
};
/** RFC 8414 §3 : le chemin de l'émetteur est ajouté après le segment well-known. */
const wellKnown = (base: string, name: string) => {
  const url = new URL(base);
  const suffix = url.pathname.replace(/\/+$/, '');
  return `${url.origin}/.well-known/${name}${suffix === '/' ? '' : suffix}`;
};
const pkceChallenge = (verifier: string) => createHash('sha256').update(verifier).digest('base64url');

export type ToolboxConnectionState = 'disconnected' | 'connected' | 'expired';
export type ToolboxAuthStatus = {
  state: ToolboxConnectionState;
  connectedAt: string | null;
  connectedBy: string | null;
  expiresAt: string | null;
  refreshable: boolean;
  scope: string | null;
};
export type ToolboxCallbackResult = { ok: true } | { ok: false; code: string };

const PENDING_TTL_MS = 30 * 60 * 1000; // l'utilisateur crée et colle un token API Infomaniak pendant le flux (même durée que la Toolbox)
const EXPIRY_SKEW_MS = 60 * 1000;

export function createToolboxAuth(config: ToolboxAuthConfig, deps: { store: ToolboxTokenStore; fetch?: typeof fetch; now?: () => Date }) {
  const doFetch = deps.fetch ?? fetch;
  const now = deps.now ?? (() => new Date());
  const scope = config.scope ?? 'mail';
  const timeoutMs = config.timeoutMs ?? 20_000;
  type Pending = { verifier: string; clientId: string; issuer: string; tokenEndpoint: string; resource: string; refreshSupported: boolean; issRequired: boolean; actor: { id: string | null; display: string | null }; expiresAt: number };
  const pending = new Map<string, Pending>();
  let refreshing: Promise<string | null> | null = null;

  async function request(url: string, init: RequestInit = {}): Promise<{ status: number; json: unknown }> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await doFetch(url, { ...init, signal: controller.signal, headers: { accept: 'application/json', ...(init.headers ?? {}) } });
      const text = await response.text();
      let json: unknown = null;
      try { json = text ? JSON.parse(text) : null; } catch { json = null; }
      return { status: response.status, json };
    } catch {
      throw new ToolboxError(controller.signal.aborted ? 'toolbox_timeout' : 'toolbox_unavailable', 'Serveur d’autorisation Toolbox injoignable');
    } finally {
      clearTimeout(timer);
    }
  }

  async function discover(): Promise<ToolboxDiscovery> {
    let resourceMeta: z.infer<typeof protectedResourceSchema> | null = null;
    for (const url of [wellKnown(new URL(config.mcpUrl).origin, 'oauth-protected-resource'), wellKnown(config.mcpUrl, 'oauth-protected-resource')]) {
      const res = await request(url);
      const parsed = protectedResourceSchema.safeParse(res.json);
      if (res.status === 200 && parsed.success) { resourceMeta = parsed.data; break; }
    }
    if (!resourceMeta) throw new ToolboxError('toolbox_unavailable', 'Métadonnées OAuth de la Toolbox introuvables');
    if (!sameUrl(resourceMeta.resource, config.mcpUrl)) throw new ToolboxError('toolbox_not_configured', 'TOOLBOX_MCP_URL ne correspond pas à la ressource annoncée par la Toolbox');
    const issuer = resourceMeta.authorization_servers[0];
    const res = await request(wellKnown(issuer, 'oauth-authorization-server'));
    const server = authorizationServerSchema.safeParse(res.json);
    if (res.status !== 200 || !server.success || !sameUrl(server.data.issuer, issuer)) throw new ToolboxError('toolbox_unavailable', 'Métadonnées du serveur d’autorisation Toolbox invalides');
    if (!server.data.code_challenge_methods_supported?.includes('S256')) throw new ToolboxError('toolbox_rejected', 'Le serveur d’autorisation Toolbox n’annonce pas PKCE S256');
    return { resource: resourceMeta.resource, server: server.data };
  }

  async function registeredClient(server: AuthorizationServer): Promise<string> {
    const file = deps.store.read();
    if (file.client && file.client.issuer === server.issuer && file.client.redirectUri === config.redirectUri) return file.client.clientId;
    if (!server.registration_endpoint) throw new ToolboxError('toolbox_not_configured', 'La Toolbox n’offre pas d’enregistrement dynamique de client');
    const refresh = server.grant_types_supported?.includes('refresh_token');
    const res = await request(server.registration_endpoint, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        client_name: config.clientName ?? 'VIPER', redirect_uris: [config.redirectUri], response_types: ['code'],
        grant_types: refresh ? ['authorization_code', 'refresh_token'] : ['authorization_code'], token_endpoint_auth_method: 'none', scope
      })
    });
    const parsed = registrationSchema.safeParse(res.json);
    if (res.status < 200 || res.status >= 300 || !parsed.success) throw new ToolboxError('toolbox_rejected', 'Enregistrement du client VIPER refusé par la Toolbox (URI de redirection HTTPS ou localhost requise)', { upstreamStatus: res.status });
    deps.store.write({ ...deps.store.read(), client: { issuer: server.issuer, clientId: parsed.data.client_id, redirectUri: config.redirectUri, registeredAt: now().toISOString() } });
    return parsed.data.client_id;
  }

  function cleanupPending() {
    const t = now().getTime();
    for (const [state, item] of pending) if (item.expiresAt <= t) pending.delete(state);
  }

  const isExpired = (token: StoredToolboxToken) => Boolean(token.expiresAt && new Date(token.expiresAt).getTime() - EXPIRY_SKEW_MS <= now().getTime());
  const canRefresh = (token: StoredToolboxToken) => Boolean(token.refreshToken && token.refreshSupported);

  function invalidate(accessToken: string) {
    const file = deps.store.read();
    if (file.token && file.token.accessToken === accessToken && !file.token.invalidatedAt) {
      deps.store.write({ ...file, token: { ...file.token, invalidatedAt: now().toISOString() } });
    }
  }

  async function refresh(token: StoredToolboxToken): Promise<string | null> {
    if (!canRefresh(token)) { invalidate(token.accessToken); return null; }
    refreshing ??= (async () => {
      try {
        const res = await request(token.tokenEndpoint, {
          method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: String(token.refreshToken), client_id: token.clientId, resource: token.resource }).toString()
        });
        const parsed = tokenSchema.safeParse(res.json);
        if (res.status >= 500) throw new ToolboxError('toolbox_unavailable', 'Rafraîchissement Toolbox indisponible', { upstreamStatus: res.status });
        if (res.status !== 200 || !parsed.success) { invalidate(token.accessToken); return null; }
        const file = deps.store.read();
        if (!file.token) return null; // déconnecté pendant le rafraîchissement
        const at = now();
        deps.store.write({
          ...file, token: {
            ...file.token, accessToken: parsed.data.access_token, refreshToken: parsed.data.refresh_token ?? file.token.refreshToken,
            expiresAt: parsed.data.expires_in ? new Date(at.getTime() + parsed.data.expires_in * 1000).toISOString() : null,
            scope: parsed.data.scope ?? file.token.scope, obtainedAt: at.toISOString(), invalidatedAt: null
          }
        });
        return parsed.data.access_token;
      } finally {
        refreshing = null;
      }
    })();
    return refreshing;
  }

  const tokens: ToolboxTokenProvider = {
    async accessToken() {
      const token = deps.store.read().token;
      if (!token || token.invalidatedAt) return null;
      return isExpired(token) ? refresh(token) : token.accessToken;
    },
    async refreshAfterUnauthorized(rejected) {
      const token = deps.store.read().token;
      if (!token) return null;
      if (token.accessToken !== rejected && !token.invalidatedAt) return token.accessToken; // déjà rafraîchi par un autre appel
      return refresh(token);
    }
  };

  return {
    tokens,
    discover,

    status(): ToolboxAuthStatus {
      const file = deps.store.read();
      const token = file.token;
      const state: ToolboxConnectionState = !token ? 'disconnected' : token.invalidatedAt || (isExpired(token) && !canRefresh(token)) ? 'expired' : 'connected';
      return {
        state, connectedAt: token ? file.connectedAt ?? token.obtainedAt : null, connectedBy: token ? file.connectedBy?.display ?? file.connectedBy?.id ?? null : null,
        expiresAt: token?.expiresAt ?? null, refreshable: Boolean(token && canRefresh(token)), scope: token?.scope ?? null
      };
    },

    /** Démarre le flux pour l'utilisateur VIPER authentifié : renvoie l'URL d'autorisation Toolbox vers laquelle rediriger le navigateur. */
    async start(actor: Actor): Promise<{ authorizationUrl: string }> {
      cleanupPending();
      const { resource, server } = await discover();
      const clientId = await registeredClient(server);
      const state = randomBytes(32).toString('base64url');
      const verifier = randomBytes(48).toString('base64url');
      pending.set(state, {
        verifier, clientId, issuer: server.issuer, tokenEndpoint: server.token_endpoint, resource,
        refreshSupported: Boolean(server.grant_types_supported?.includes('refresh_token')),
        issRequired: Boolean(server.authorization_response_iss_parameter_supported),
        actor: { id: actor.id ?? null, display: actor.display ?? null }, expiresAt: now().getTime() + PENDING_TTL_MS
      });
      const url = new URL(server.authorization_endpoint);
      url.searchParams.set('response_type', 'code');
      url.searchParams.set('client_id', clientId);
      url.searchParams.set('redirect_uri', config.redirectUri);
      url.searchParams.set('code_challenge', pkceChallenge(verifier));
      url.searchParams.set('code_challenge_method', 'S256');
      url.searchParams.set('scope', scope);
      url.searchParams.set('resource', resource);
      url.searchParams.set('state', state);
      return { authorizationUrl: url.toString() };
    },

    /** Retour navigateur (`redirect_uri`) : `state` à usage unique, `iss` vérifié, échange du code. Ne lève pas : code de résultat. */
    async complete(query: Record<string, unknown>): Promise<ToolboxCallbackResult> {
      cleanupPending();
      const value = (key: string) => typeof query[key] === 'string' ? query[key] as string : '';
      const state = value('state');
      const item = state ? pending.get(state) : undefined;
      if (!item) return { ok: false, code: 'toolbox_state_invalid' };
      pending.delete(state);
      if (value('error')) return { ok: false, code: value('error') === 'access_denied' ? 'toolbox_access_denied' : 'toolbox_authorization_failed' };
      const iss = value('iss');
      if ((iss && !sameUrl(iss, item.issuer)) || (!iss && item.issRequired)) return { ok: false, code: 'toolbox_issuer_mismatch' };
      const code = value('code');
      if (!code) return { ok: false, code: 'toolbox_authorization_failed' };
      let res: { status: number; json: unknown };
      try {
        res = await request(item.tokenEndpoint, {
          method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ grant_type: 'authorization_code', code, client_id: item.clientId, redirect_uri: config.redirectUri, code_verifier: item.verifier, resource: item.resource }).toString()
        });
      } catch (e) {
        return { ok: false, code: e instanceof ToolboxError ? e.code : 'toolbox_unavailable' };
      }
      const parsed = tokenSchema.safeParse(res.json);
      if (res.status !== 200 || !parsed.success) return { ok: false, code: 'toolbox_token_exchange_failed' };
      if (parsed.data.token_type && parsed.data.token_type.toLowerCase() !== 'bearer') return { ok: false, code: 'toolbox_token_exchange_failed' };
      const grantedScope = parsed.data.scope ?? scope;
      if (!grantedScope.split(/\s+/).includes('mail')) return { ok: false, code: 'toolbox_scope_missing' };
      const at = now();
      deps.store.write({
        ...deps.store.read(),
        token: {
          accessToken: parsed.data.access_token, refreshToken: parsed.data.refresh_token ?? null,
          expiresAt: parsed.data.expires_in ? new Date(at.getTime() + parsed.data.expires_in * 1000).toISOString() : null,
          scope: grantedScope, issuer: item.issuer, resource: item.resource, tokenEndpoint: item.tokenEndpoint, clientId: item.clientId,
          refreshSupported: item.refreshSupported, obtainedAt: at.toISOString(), invalidatedAt: null
        },
        connectedBy: item.actor, connectedAt: at.toISOString()
      });
      return { ok: true };
    },

    /** Oublie le jeton côté VIPER (la Toolbox n'expose pas de révocation ; le jeton expire de lui-même). L'enregistrement client est gardé. */
    disconnect() {
      const file = deps.store.read();
      delete file.token;
      delete file.connectedBy;
      delete file.connectedAt;
      deps.store.write(file);
    }
  };
}
export type ToolboxAuth = ReturnType<typeof createToolboxAuth>;
