// Intégration CIRCOE Toolbox côté VIPER (Task 15) : configuration par environnement, état de connexion exposé à l'UI (sans secret),
// brouillon distant Infomaniak créé à la validation/programmation (`RemoteDraftPort`), worker de suppression des brouillons
// obsolètes (`contact_message_remote_draft_cleanups`). Désactivée par défaut (`TOOLBOX_MAIL_ENABLED`) : sans flag, sans
// configuration complète ou sans connexion, le port reste `noRemoteDrafts` et le comportement Task 12-14 est inchangé.
//
// L'envoi programmé (scan, verrou, `sendDraft`, `markSent`, réconciliation `listDrafts`) est dans `contactMessageDispatcher.ts`
// (Task 16), qui obtient le client via `integration.mailToolbox()` (null si inactive) et recrée le brouillon distant manquant
// par `syncRemoteDraft` avant l'envoi.
import path from 'node:path';
import { noRemoteDrafts } from './contactMessageService.js';
import { createFileTokenStore, createToolboxAuth } from './toolboxAuth.js';
import { createMcpMailToolbox, ToolboxError } from './toolboxMcpClient.js';
/** Valeur de `contact_messages.remote_provider` pour les brouillons créés via la Toolbox. */
export const TOOLBOX_PROVIDER = 'circoe_toolbox';
const truthy = (raw) => ['1', 'true', 'yes', 'on'].includes(String(raw ?? '').trim().toLowerCase());
const intIn = (raw, fallback, min, max) => {
    const n = Number(raw);
    return raw?.trim() && Number.isInteger(n) ? Math.min(max, Math.max(min, n)) : fallback;
};
/** HTTPS, ou HTTP sur la boucle locale seulement (même règle que la Toolbox pour les URI de redirection). */
export function isAllowedToolboxUrl(value) {
    try {
        const url = new URL(value);
        if (url.protocol === 'https:')
            return true;
        return url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    }
    catch {
        return false;
    }
}
const isInside = (child, parent) => {
    const rel = path.relative(parent, child);
    return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
};
/**
 * Lit la configuration (noms de variables seulement dans `missing`, jamais de valeur). Jetons : `TOOLBOX_TOKEN_STORE_PATH` ou
 * `<VIPER_STORAGE_DIR>/toolbox-oauth.json`, refusé s'il tombe dans le dépôt (`checkoutDir`).
 */
export function toolboxSettingsFromEnv(env, opts) {
    const enabled = truthy(env.TOOLBOX_MAIL_ENABLED);
    const missing = [];
    const mcpUrl = env.TOOLBOX_MCP_URL?.trim() ?? '';
    const redirectUri = env.TOOLBOX_OAUTH_REDIRECT_URI?.trim() ?? '';
    const tokenStorePath = path.resolve(env.TOOLBOX_TOKEN_STORE_PATH?.trim() || path.join(opts.storageDir, 'toolbox-oauth.json'));
    if (!isAllowedToolboxUrl(mcpUrl))
        missing.push('TOOLBOX_MCP_URL');
    if (!isAllowedToolboxUrl(redirectUri))
        missing.push('TOOLBOX_OAUTH_REDIRECT_URI');
    if (isInside(tokenStorePath, path.resolve(opts.checkoutDir ?? process.cwd())))
        missing.push('TOOLBOX_TOKEN_STORE_PATH');
    const config = missing.length ? null : {
        mcpUrl, redirectUri, tokenStorePath,
        timeoutMs: intIn(env.TOOLBOX_TIMEOUT_MS, 20_000, 1_000, 120_000),
        cleanupIntervalMs: intIn(env.TOOLBOX_CLEANUP_INTERVAL_MS, 60_000, 0, 24 * 3600_000)
    };
    return { enabled, config, missing };
}
// --- Port brouillon distant ---
/** Brouillon Infomaniak d'un message validé : destinataires, objet, corps texte ; le From est la boîte liée à la connexion Toolbox. */
export const toolboxRemoteDrafts = (toolbox) => ({
    async createDraft(message) {
        const { draftId } = await toolbox.createDraft({
            to: message.to_recipients, cc: message.cc_recipients, bcc: message.bcc_recipients, subject: message.subject, text: message.body_text
        });
        return { provider: TOOLBOX_PROVIDER, draftId };
    }
});
/** Attente avant nouvelle tentative : 30 s x 2^(tentatives-1), plafonnée à 6 h. */
export const cleanupBackoffMs = (attempts) => attempts <= 0 ? 0 : Math.min(6 * 3600_000, 30_000 * 2 ** Math.min(attempts - 1, 20));
/**
 * Supprime chez Infomaniak les brouillons obsolètes (édition, annulation, remplacement). Un brouillon déjà absent compte comme
 * supprimé ; un id encore rattaché à un message n'est jamais supprimé ; une erreur d'authentification/configuration interrompt le
 * lot sans compter de tentative (rien n'est la faute du brouillon). Seuls des codes sont stockés (jamais de texte amont).
 */
export async function processRemoteDraftCleanups(db, toolbox, opts = {}) {
    const now = opts.now ?? (() => new Date());
    const report = { processed: 0, deleted: 0, alreadyAbsent: 0, failed: 0, skipped: 0, blocked: null };
    const rows = db.prepare('SELECT id,remote_draft_id,attempts,last_attempt_at FROM contact_message_remote_draft_cleanups WHERE completed_at IS NULL AND remote_provider=? ORDER BY created_at,rowid LIMIT ?')
        .all(TOOLBOX_PROVIDER, opts.limit ?? 20);
    const record = db.prepare('UPDATE contact_message_remote_draft_cleanups SET attempts=attempts+1,last_attempt_at=?,last_error_code=?,completed_at=? WHERE id=? AND completed_at IS NULL');
    for (const row of rows) {
        const at = now();
        if (row.last_attempt_at && at.getTime() - new Date(row.last_attempt_at).getTime() < cleanupBackoffMs(row.attempts)) {
            report.skipped++;
            continue;
        }
        const attached = db.prepare('SELECT 1 FROM contact_messages WHERE remote_provider=? AND remote_draft_id=?').get(TOOLBOX_PROVIDER, row.remote_draft_id);
        if (attached) {
            record.run(at.toISOString(), 'still_attached', null, row.id);
            report.skipped++;
            continue;
        }
        try {
            const { deleted } = await toolbox.deleteDraft(row.remote_draft_id);
            record.run(at.toISOString(), null, now().toISOString(), row.id);
            report.processed++;
            if (deleted)
                report.deleted++;
            else
                report.alreadyAbsent++;
        }
        catch (e) {
            const code = e instanceof ToolboxError ? e.code : 'toolbox_unavailable';
            if (code === 'toolbox_auth_required' || code === 'toolbox_not_configured') {
                report.blocked = code;
                break;
            }
            record.run(at.toISOString(), code, null, row.id);
            report.processed++;
            report.failed++;
        }
    }
    return report;
}
export function createToolboxIntegration(deps) {
    const { settings } = deps;
    const log = deps.log ?? (line => console.log(line));
    const config = settings.enabled ? settings.config : null;
    const auth = config
        ? createToolboxAuth({ mcpUrl: config.mcpUrl, redirectUri: config.redirectUri, tokenStorePath: config.tokenStorePath, timeoutMs: config.timeoutMs }, { store: deps.store ?? createFileTokenStore(config.tokenStorePath), fetch: deps.fetch, now: deps.now })
        : null;
    const toolbox = config && auth
        ? createMcpMailToolbox({ mcpUrl: config.mcpUrl, tokens: auth.tokens, timeoutMs: config.timeoutMs, fetch: deps.fetch })
        : null;
    let running = null;
    let timer = null;
    const connected = () => Boolean(auth && auth.status().state === 'connected');
    const requireAuth = () => {
        if (!auth)
            throw new ToolboxError('toolbox_not_configured', settings.enabled ? `Toolbox non configurée (${settings.missing.join(', ')})` : 'Intégration Toolbox désactivée (TOOLBOX_MAIL_ENABLED)');
        return auth;
    };
    function cleanupCounts() {
        try {
            const row = deps.getDb().prepare('SELECT count(*) pending, sum(CASE WHEN last_error_code IS NOT NULL THEN 1 ELSE 0 END) failing FROM contact_message_remote_draft_cleanups WHERE completed_at IS NULL')
                .get();
            return { pending: Number(row.pending), failing: Number(row.failing ?? 0) };
        }
        catch {
            return { pending: 0, failing: 0 };
        }
    }
    const integration = {
        status() {
            const connection = auth?.status() ?? null;
            const state = !settings.enabled ? 'disabled' : !auth ? 'not_configured' : connection.state;
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
        startAuthorization: async (actor) => requireAuth().start(actor),
        async completeAuthorization(query) {
            if (!auth)
                return { ok: false, code: 'toolbox_not_configured' };
            const result = await auth.complete(query);
            log(result.ok ? '[toolbox] connexion établie' : `[toolbox] connexion refusée : ${result.code}`);
            if (result.ok)
                integration.kickCleanup();
            return result;
        },
        disconnect() {
            requireAuth().disconnect();
            log('[toolbox] connexion oubliée côté VIPER');
        },
        /** Client MCP mail si l'intégration est active et connectée (Task 16 : `sendDraft`, `listDrafts`), sinon `null`. */
        mailToolbox: () => toolbox && connected() ? toolbox : null,
        /** Port injecté dans le service messages : réel seulement si activé, configuré et connecté. */
        remoteDrafts: () => toolbox && connected() ? toolboxRemoteDrafts(toolbox) : noRemoteDrafts,
        /** Une passe de la file de suppression (sans chevauchement) ; `null` si l'intégration est inactive. */
        runCleanups() {
            if (!toolbox || !connected())
                return Promise.resolve(null);
            running ??= processRemoteDraftCleanups(deps.getDb(), toolbox, { now: deps.now })
                .then(report => {
                if (report.processed || report.blocked)
                    log(`[toolbox] file brouillons : ${JSON.stringify(report)}`);
                return report;
            })
                .catch(e => { log(`[toolbox] file brouillons en échec : ${e instanceof ToolboxError ? e.code : 'erreur interne'}`); return null; })
                .finally(() => { running = null; });
            return running;
        },
        /** Déclenchement non bloquant après une mutation susceptible de remplir la file. */
        kickCleanup() { void integration.runCleanups(); },
        startCleanupWorker() {
            if (!config || !config.cleanupIntervalMs || timer)
                return;
            timer = setInterval(() => integration.kickCleanup(), config.cleanupIntervalMs);
            timer.unref?.();
            integration.kickCleanup();
        },
        stopCleanupWorker() { if (timer)
            clearInterval(timer); timer = null; }
    };
    return integration;
}
/** Destination relative du navigateur après le retour OAuth (même origine que l'URI de redirection) ; codes seulement. */
export const callbackReturnPath = (result) => result.ok ? '/?toolbox=connected' : `/?toolbox=error&code=${encodeURIComponent(result.code)}`;
