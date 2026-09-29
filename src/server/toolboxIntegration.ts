// Intégration CIRCOE Toolbox côté VIPER (Task 15) : configuration par environnement, état de connexion exposé à l'UI (sans secret),
// brouillon distant Infomaniak créé à la validation/programmation (`RemoteDraftPort`), worker de suppression des brouillons
// obsolètes (`contact_message_remote_draft_cleanups`). Désactivée par défaut (`TOOLBOX_MAIL_ENABLED`) : sans flag, sans
// configuration complète ou sans connexion, le port reste `noRemoteDrafts` et le comportement Task 12-14 est inchangé.
//
// Hors périmètre (Task 16) : scan des messages programmés, verrou de dispatch, `sendDraft`, `markSent`, réconciliation `listDrafts`.
// La Task 16 obtient le client via `integration.mailToolbox()` (null si inactive) et doit (re)créer le brouillon distant par
// `syncRemoteDraft` avant l'envoi s'il manque (validation faite pendant que la Toolbox était déconnectée).
import path from 'node:path';
import type Database from 'better-sqlite3';
import type { Actor } from './audit.js';
import { noRemoteDrafts, type RemoteDraftPort } from './contactMessageService.js';
import { createFileTokenStore, createToolboxAuth, type ToolboxAuth, type ToolboxAuthStatus, type ToolboxTokenStore } from './toolboxAuth.js';
import { createMcpMailToolbox, ToolboxError, type MailToolbox, type ToolboxErrorCode } from './toolboxMcpClient.js';

type Db = Database.Database;

/** Valeur de `contact_messages.remote_provider` pour les brouillons créés via la Toolbox. */
export const TOOLBOX_PROVIDER = 'circoe_toolbox';

// --- Configuration ---
export type ToolboxConfig = { mcpUrl: string; redirectUri: string; tokenStorePath: string; timeoutMs: number; cleanupIntervalMs: number };
export type ToolboxSettings = { enabled: boolean; config: ToolboxConfig | null; missing: string[] };
const truthy = (raw: string | undefined) => ['1', 'true', 'yes', 'on'].includes(String(raw ?? '').trim().toLowerCase());
const intIn = (raw: string | undefined, fallback: number, min: number, max: number) => {
  const n = Number(raw);
  return raw?.trim() && Number.isInteger(n) ? Math.min(max, Math.max(min, n)) : fallback;
};
/** HTTPS, ou HTTP sur la boucle locale seulement (même règle que la Toolbox pour les URI de redirection). */
export function isAllowedToolboxUrl(value: string): boolean {
  try {
    const url = new URL(value);
    if (url.protocol === 'https:') return true;
    return url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  } catch { return false; }
}
const isInside = (child: string, parent: string) => {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
};
/**
 * Lit la configuration (noms de variables seulement dans `missing`, jamais de valeur). Jetons : `TOOLBOX_TOKEN_STORE_PATH` ou
 * `<VIPER_STORAGE_DIR>/toolbox-oauth.json`, refusé s'il tombe dans le dépôt (`checkoutDir`).
 */
export function toolboxSettingsFromEnv(env: Record<string, string | undefined>, opts: { storageDir: string; checkoutDir?: string }): ToolboxSettings {
  const enabled = truthy(env.TOOLBOX_MAIL_ENABLED);
  const missing: string[] = [];
  const mcpUrl = env.TOOLBOX_MCP_URL?.trim() ?? '';
  const redirectUri = env.TOOLBOX_OAUTH_REDIRECT_URI?.trim() ?? '';
  const tokenStorePath = path.resolve(env.TOOLBOX_TOKEN_STORE_PATH?.trim() || path.join(opts.storageDir, 'toolbox-oauth.json'));
  if (!isAllowedToolboxUrl(mcpUrl)) missing.push('TOOLBOX_MCP_URL');
  if (!isAllowedToolboxUrl(redirectUri)) missing.push('TOOLBOX_OAUTH_REDIRECT_URI');
  if (isInside(tokenStorePath, path.resolve(opts.checkoutDir ?? process.cwd()))) missing.push('TOOLBOX_TOKEN_STORE_PATH');
  const config = missing.length ? null : {
    mcpUrl, redirectUri, tokenStorePath,
    timeoutMs: intIn(env.TOOLBOX_TIMEOUT_MS, 20_000, 1_000, 120_000),
    cleanupIntervalMs: intIn(env.TOOLBOX_CLEANUP_INTERVAL_MS, 60_000, 0, 24 * 3600_000)
  };
  return { enabled, config, missing };
}

// --- Port brouillon distant ---
/** Brouillon Infomaniak d'un message validé : destinataires, objet, corps texte ; le From est la boîte liée à la connexion Toolbox. */
export const toolboxRemoteDrafts = (toolbox: MailToolbox): RemoteDraftPort => ({
  async createDraft(message) {
    const { draftId } = await toolbox.createDraft({
      to: message.to_recipients, cc: message.cc_recipients, bcc: message.bcc_recipients, subject: message.subject, text: message.body_text
    });
    return { provider: TOOLBOX_PROVIDER, draftId };
  }
});

// --- File de suppression ---
export type RemoteDraftCleanupReport = { processed: number; deleted: number; alreadyAbsent: number; failed: number; skipped: number; blocked: ToolboxErrorCode | null };
type CleanupRow = { id: string; remote_draft_id: string; attempts: number; last_attempt_at: string | null };
/** Attente avant nouvelle tentative : 30 s x 2^(tentatives-1), plafonnée à 6 h. */
export const cleanupBackoffMs = (attempts: number) => attempts <= 0 ? 0 : Math.min(6 * 3600_000, 30_000 * 2 ** Math.min(attempts - 1, 20));
/**
 * Supprime chez Infomaniak les brouillons obsolètes (édition, annulation, remplacement). Un brouillon déjà absent compte comme
 * supprimé ; un id encore rattaché à un message n'est jamais supprimé ; une erreur d'authentification/configuration interrompt le
 * lot sans compter de tentative (rien n'est la faute du brouillon). Seuls des codes sont stockés (jamais de texte amont).
 */
export async function processRemoteDraftCleanups(db: Db, toolbox: MailToolbox, opts: { now?: () => Date; limit?: number } = {}): Promise<RemoteDraftCleanupReport> {
  const now = opts.now ?? (() => new Date());
  const report: RemoteDraftCleanupReport = { processed: 0, deleted: 0, alreadyAbsent: 0, failed: 0, skipped: 0, blocked: null };
  const rows = db.prepare('SELECT id,remote_draft_id,attempts,last_attempt_at FROM contact_message_remote_draft_cleanups WHERE completed_at IS NULL AND remote_provider=? ORDER BY created_at,rowid LIMIT ?')
    .all(TOOLBOX_PROVIDER, opts.limit ?? 20) as CleanupRow[];
  const record = db.prepare('UPDATE contact_message_remote_draft_cleanups SET attempts=attempts+1,last_attempt_at=?,last_error_code=?,completed_at=? WHERE id=? AND completed_at IS NULL');
  for (const row of rows) {
    const at = now();
    if (row.last_attempt_at && at.getTime() - new Date(row.last_attempt_at).getTime() < cleanupBackoffMs(row.attempts)) { report.skipped++; continue; }
    const attached = db.prepare('SELECT 1 FROM contact_messages WHERE remote_provider=? AND remote_draft_id=?').get(TOOLBOX_PROVIDER, row.remote_draft_id);
    if (attached) { record.run(at.toISOString(), 'still_attached', null, row.id); report.skipped++; continue; }
    try {
      const { deleted } = await toolbox.deleteDraft(row.remote_draft_id);
      record.run(at.toISOString(), null, now().toISOString(), row.id);
      report.processed++;
      if (deleted) report.deleted++; else report.alreadyAbsent++;
    } catch (e) {
      const code: ToolboxErrorCode = e instanceof ToolboxError ? e.code : 'toolbox_unavailable';
      if (code === 'toolbox_auth_required' || code === 'toolbox_not_configured') { report.blocked = code; break; }
      record.run(at.toISOString(), code, null, row.id);
      report.processed++;
      report.failed++;
    }
  }
  return report;
}

// --- Intégration (singleton serveur : les demandes d'autorisation en cours vivent en mémoire) ---
export type ToolboxUiState = 'disabled' | 'not_configured' | 'disconnected' | 'connected' | 'expired';
export type ToolboxStatus = {
  enabled: boolean;
  state: ToolboxUiState;
  /** Noms de variables d'environnement manquantes ou invalides (jamais de valeur). */
  missing: string[];
  /** Origine publique de la Toolbox (pas de chemin, pas de secret). */
  toolboxOrigin: string | null;
  connection: Omit<ToolboxAuthStatus, 'state'> | null;
  cleanups: { pending: number; failing: number };
};

export type ToolboxIntegrationDeps = {
  getDb: () => Db;
  settings: ToolboxSettings;
  store?: ToolboxTokenStore;
  fetch?: typeof fetch;
  now?: () => Date;
  log?: (line: string) => void;
};

export function createToolboxIntegration(deps: ToolboxIntegrationDeps) {
  const { settings } = deps;
  const log = deps.log ?? (line => console.log(line));
  const config = settings.enabled ? settings.config : null;
  const auth: ToolboxAuth | null = config
    ? createToolboxAuth({ mcpUrl: config.mcpUrl, redirectUri: config.redirectUri, tokenStorePath: config.tokenStorePath, timeoutMs: config.timeoutMs },
      { store: deps.store ?? createFileTokenStore(config.tokenStorePath), fetch: deps.fetch, now: deps.now })
    : null;
  const toolbox: MailToolbox | null = config && auth
    ? createMcpMailToolbox({ mcpUrl: config.mcpUrl, tokens: auth.tokens, timeoutMs: config.timeoutMs, fetch: deps.fetch })
    : null;
  let running: Promise<RemoteDraftCleanupReport | null> | null = null;
  let timer: ReturnType<typeof setInterval> | null = null;

  const connected = () => Boolean(auth && auth.status().state === 'connected');
  const requireAuth = (): ToolboxAuth => {
    if (!auth) throw new ToolboxError('toolbox_not_configured', settings.enabled ? `Toolbox non configurée (${settings.missing.join(', ')})` : 'Intégration Toolbox désactivée (TOOLBOX_MAIL_ENABLED)');
    return auth;
  };

  function cleanupCounts() {
    try {
      const row = deps.getDb().prepare('SELECT count(*) pending, sum(CASE WHEN last_error_code IS NOT NULL THEN 1 ELSE 0 END) failing FROM contact_message_remote_draft_cleanups WHERE completed_at IS NULL')
        .get() as { pending: number; failing: number | null };
      return { pending: Number(row.pending), failing: Number(row.failing ?? 0) };
    } catch { return { pending: 0, failing: 0 }; }
  }

  const integration = {
    status(): ToolboxStatus {
      const connection = auth?.status() ?? null;
      const state: ToolboxUiState = !settings.enabled ? 'disabled' : !auth ? 'not_configured' : connection!.state;
      return {
        enabled: settings.enabled, state, missing: settings.enabled ? settings.missing : [],
        toolboxOrigin: config ? new URL(config.mcpUrl).origin : null,
        connection: connection && connection.state !== 'disconnected' ? {
          connectedAt: connection.connectedAt, connectedBy: connection.connectedBy, expiresAt: connection.expiresAt,
          refreshable: connection.refreshable, scope: connection.scope
        } : null,
        cleanups: cleanupCounts()
      };
    },
    startAuthorization: async (actor: Actor) => requireAuth().start(actor),
    async completeAuthorization(query: Record<string, unknown>) {
      if (!auth) return { ok: false as const, code: 'toolbox_not_configured' };
      const result = await auth.complete(query);
      log(result.ok ? '[toolbox] connexion établie' : `[toolbox] connexion refusée : ${result.code}`);
      if (result.ok) integration.kickCleanup();
      return result;
    },
    disconnect() {
      requireAuth().disconnect();
      log('[toolbox] connexion oubliée côté VIPER');
    },
    /** Client MCP mail si l'intégration est active et connectée (Task 16 : `sendDraft`, `listDrafts`), sinon `null`. */
    mailToolbox: (): MailToolbox | null => toolbox && connected() ? toolbox : null,
    /** Port injecté dans le service messages : réel seulement si activé, configuré et connecté. */
    remoteDrafts: (): RemoteDraftPort => toolbox && connected() ? toolboxRemoteDrafts(toolbox) : noRemoteDrafts,
    /** Une passe de la file de suppression (sans chevauchement) ; `null` si l'intégration est inactive. */
    runCleanups(): Promise<RemoteDraftCleanupReport | null> {
      if (!toolbox || !connected()) return Promise.resolve(null);
      running ??= processRemoteDraftCleanups(deps.getDb(), toolbox, { now: deps.now })
        .then(report => {
          if (report.processed || report.blocked) log(`[toolbox] file brouillons : ${JSON.stringify(report)}`);
          return report;
        })
        .catch(e => { log(`[toolbox] file brouillons en échec : ${e instanceof ToolboxError ? e.code : 'erreur interne'}`); return null; })
        .finally(() => { running = null; });
      return running;
    },
    /** Déclenchement non bloquant après une mutation susceptible de remplir la file. */
    kickCleanup() { void integration.runCleanups(); },
    startCleanupWorker() {
      if (!config || !config.cleanupIntervalMs || timer) return;
      timer = setInterval(() => integration.kickCleanup(), config.cleanupIntervalMs);
      timer.unref?.();
      integration.kickCleanup();
    },
    stopCleanupWorker() { if (timer) clearInterval(timer); timer = null; }
  };
  return integration;
}
export type ToolboxIntegration = ReturnType<typeof createToolboxIntegration>;

/** Destination relative du navigateur après le retour OAuth (même origine que l'URI de redirection) ; codes seulement. */
export const callbackReturnPath = (result: { ok: true } | { ok: false; code: string }): string =>
  result.ok ? '/?toolbox=connected' : `/?toolbox=error&code=${encodeURIComponent(result.code)}`;
