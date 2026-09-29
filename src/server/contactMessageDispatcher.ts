// Envoi programmé des messages Contact/R1/R2 (Task 16, décisions 10, 21-25, 29 ; docs/02 §6-7) : VIPER porte `scheduled_at`,
// ce dispatcher (dans le process serveur) déclenche `send_draft` de la CIRCOE Toolbox au moment voulu. Aucune transition
// d'état prospect ici : seul le statut du message change (`scheduled` -> `sent`, ou retour `validated` pour revue humaine).
//
// Modèle d'exécution (une passe = `runScan`, jamais deux en parallèle dans un process ; intervalle `CONTACT_DISPATCH_INTERVAL_MS`) :
// 1. Toolbox inactive (flag off, non configurée, non connectée) => rien.
// 2. Réconciliation des verrous orphelins (`scheduled` + `dispatch_claim_id` plus vieux que `claimTtlMs`, absent des envois en
//    cours de ce process) : process tué pendant un envoi, issue inconnue (timeout/coupure), `markSent` impossible après envoi.
//    `list_drafts` : brouillon disparu (liste non tronquée) => `sent` (réconcilié) ; brouillon présent => retour `validated` avec
//    `send_not_confirmed` (un humain décide de reprogrammer) ; liste tronquée ou illisible => rien, nouvel essai à la passe suivante.
//    Un verrou n'est JAMAIS relâché vers un renvoi automatique.
// 3. Messages dus (`scheduled`, `scheduled_at <= now`, non verrouillés), pour chacun :
//    - séquence fermée (réponse, RDV, ignoré, à ne plus contacter) => annulation mécanique (décision 29) ;
//    - retard > `maxLatenessMs` (serveur éteint, Toolbox déconnectée) => pas d'envoi tardif : retour `validated` + `dispatch_overdue` ;
//    - échec précédent encore en attente (backoff exponentiel) => passe suivante ;
//    - brouillon distant absent => `syncRemoteDraft` (création Toolbox) puis verrou à une passe ultérieure ou dans la foulée ;
//    - verrou atomique (UPDATE conditionnel dans une transaction IMMEDIATE : toujours `scheduled`, dû, non verrouillé, même
//      révision, validation courante, même brouillon distant, même nombre de tentatives) avec revérification de l'état prospect
//      dans la même transaction, `dispatch_attempts+1`, événement `dispatch_claimed` ; puis `sendDraft` sans autre attente ;
//    - succès => `markSent` (un seul UPDATE, événement `sent`) ;
//    - échec certain (requête refusée avant envoi) : transitoire (Toolbox injoignable/429, délai à l'initialisation, auth) =>
//      verrou relâché, `last_error_code`, nouvel essai après backoff, au plus `maxAttempts` ; définitif (allowlist, refus,
//      brouillon introuvable) ou tentatives épuisées => retour `validated` + code ; toujours `send_failed`, jamais `sent` ;
//    - issue inconnue (timeout/coupure/5xx pendant `send_draft`, réponse illisible, erreur interne) => verrou CONSERVÉ,
//      `last_error_code='send_outcome_unknown'`, réconciliation après `claimTtlMs` (étape 2), jamais de renvoi.
// Anti-double-envoi : un `send_draft` exige un verrou gagné par UPDATE conditionnel (deux passes ou deux process concurrents : un
// seul gagne) ; un verrou n'est relâché pour un nouvel essai qu'après un échec CERTAIN ; `sent` est immuable (trigger).
// Annulation pendant un envoi (`inFlight` de `cancelFutureContactMessages`) : l'état prospect est relu dans la transaction du verrou
// (juste avant `send_draft`) ; après un échec le message relâché est annulé si la séquence s'est fermée entre-temps.
// Journal/audit : identifiants, codes et statuts seulement (jamais sujet, corps ni adresse).
import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import type { Actor } from './audit.js';
import { appendContactMessageEvent, cancelFutureContactMessages, getContactMessageById, type ContactMessageRecord } from './contactMessageStore.js';
import { createContactMessageService, type RemoteDraftPort } from './contactMessageService.js';
import { ToolboxError, type MailToolbox, type ToolboxDraftSummary, type ToolboxErrorCode } from './toolboxMcpClient.js';
import { isContactSequenceClosed } from '../shared/contactWorkflow.js';

type Db = Database.Database;

export const DISPATCH_ACTOR: Actor = { type: 'system', id: 'contact-dispatcher', display: 'Envoi programmé VIPER' };
/** Taille de page de `list_drafts` (maximum Toolbox) : une liste pleine ne prouve pas l'absence d'un brouillon. */
export const RECONCILE_LIST_LIMIT = 100;
/** Codes de diagnostic propres au dispatcher (en plus des `ToolboxErrorCode`). */
export const dispatchCodes = {
  overdue: 'dispatch_overdue',
  outcomeUnknown: 'send_outcome_unknown',
  notConfirmed: 'send_not_confirmed',
  missingRecipients: 'missing_recipients',
  internal: 'dispatch_internal_error'
} as const;

// --- Configuration ---
export type ContactDispatchConfig = {
  /** Période du scan (0 = dispatcher arrêté). */
  intervalMs: number;
  /** Retard maximal toléré après `scheduled_at` ; au-delà le message revient à `validated` sans être envoyé. */
  maxLatenessMs: number;
  /** Âge au-delà duquel un verrou d'envoi est considéré orphelin (toujours > 2 x délai Toolbox). */
  claimTtlMs: number;
  /** Tentatives d'envoi (échecs certains transitoires compris) avant retour à `validated`. */
  maxAttempts: number;
  /** Base du backoff exponentiel entre deux tentatives. */
  retryBaseMs: number;
  /** Messages dus traités au plus par passe. */
  batchSize: number;
};
const intIn = (raw: string | undefined, fallback: number, min: number, max: number) => {
  const n = Number(raw);
  return raw?.trim() && Number.isInteger(n) ? Math.min(max, Math.max(min, n)) : fallback;
};
export function contactDispatchConfigFromEnv(env: Record<string, string | undefined>, opts: { toolboxTimeoutMs: number }): ContactDispatchConfig {
  const interval = intIn(env.CONTACT_DISPATCH_INTERVAL_MS, 30_000, 0, 3600_000);
  return {
    intervalMs: interval === 0 ? 0 : Math.max(500, interval),
    maxLatenessMs: intIn(env.CONTACT_DISPATCH_MAX_LATENESS_MS, 6 * 3600_000, 60_000, 7 * 24 * 3600_000),
    claimTtlMs: Math.max(2 * opts.toolboxTimeoutMs, intIn(env.CONTACT_DISPATCH_CLAIM_TTL_MS, 10 * 60_000, 1_000, 24 * 3600_000)),
    maxAttempts: intIn(env.CONTACT_DISPATCH_MAX_ATTEMPTS, 5, 1, 20),
    retryBaseMs: intIn(env.CONTACT_DISPATCH_RETRY_BASE_MS, 60_000, 1_000, 3600_000),
    batchSize: 100
  };
}
/** Attente après la n-ième tentative échouée : base x 2^(n-1), plafonnée à 1 h. */
export const dispatchBackoffMs = (attempts: number, baseMs: number) => attempts <= 0 ? 0 : Math.min(3600_000, baseMs * 2 ** Math.min(attempts - 1, 20));

// --- Classement des erreurs d'envoi ---
export type SendOutcome = { kind: 'transient' | 'terminal' | 'uncertain'; code: string };
/** Refus certains, avant exécution, qui peuvent se résoudre seuls (Toolbox de retour, reconnexion). */
const transientCodes: ToolboxErrorCode[] = ['toolbox_not_configured', 'toolbox_auth_required', 'toolbox_unavailable', 'toolbox_timeout'];
/** Refus certains et définitifs pour ce brouillon : revue humaine. */
const terminalCodes: ToolboxErrorCode[] = ['toolbox_rejected', 'toolbox_outbound_blocked', 'toolbox_invalid_input', 'toolbox_draft_not_found'];
/**
 * `send_draft` : seule une erreur Toolbox typée, sans `outcomeUnknown`, d'un code connu, prouve que rien n'est parti.
 * Tout le reste (timeout/coupure pendant l'appel, 5xx, réponse illisible, exception inattendue) = issue inconnue.
 */
export function classifySendError(error: unknown): SendOutcome {
  if (!(error instanceof ToolboxError)) return { kind: 'uncertain', code: dispatchCodes.internal };
  if (error.outcomeUnknown) return { kind: 'uncertain', code: error.code };
  if (transientCodes.includes(error.code)) return { kind: 'transient', code: error.code };
  if (terminalCodes.includes(error.code)) return { kind: 'terminal', code: error.code };
  return { kind: 'uncertain', code: error.code };
}
/** Création du brouillon distant avant envoi : rien n'est envoyé, un doublon éventuel reste un simple brouillon orphelin. */
const classifyDraftError = (code: string): SendOutcome =>
  ({ kind: (terminalCodes as string[]).includes(code) ? 'terminal' : 'transient', code });

// --- Passe ---
export type DispatchScanReport = {
  skipped: null | 'inactive' | 'error';
  sent: number;
  /** Échecs certains transitoires : nouvel essai après backoff. */
  retrying: number;
  /** Échecs certains définitifs ou retard excessif : message revenu à `validated`. */
  failed: number;
  overdue: number;
  /** Issue inconnue : verrou conservé, réconciliation ultérieure. */
  uncertain: number;
  reconciledSent: number;
  reconciledNotSent: number;
  /** Messages annulés car la séquence du prospect est fermée. */
  cancelled: number;
  /** Reportés (backoff, brouillon distant en cours de création, Toolbox illisible pour la réconciliation). */
  deferred: number;
};
const emptyReport = (skipped: DispatchScanReport['skipped'] = null): DispatchScanReport =>
  ({ skipped, sent: 0, retrying: 0, failed: 0, overdue: 0, uncertain: 0, reconciledSent: 0, reconciledNotSent: 0, cancelled: 0, deferred: 0 });

export type ContactDispatcherDeps = {
  /** Base courante (réassignée par une restauration : relue après chaque attente réseau). */
  getDb: () => Db;
  /** Client Toolbox si l'intégration est active et connectée, sinon `null` (aucun envoi). */
  toolbox: () => MailToolbox | null;
  /** Port de création des brouillons distants (`syncRemoteDraft`). */
  remoteDrafts: () => RemoteDraftPort;
  config: ContactDispatchConfig;
  now?: () => Date;
  log?: (line: string) => void;
  newClaimId?: () => string;
};
export type ContactDispatchStatus = {
  /** Vrai si un message programmé partira effectivement (dispatcher démarré et Toolbox connectée). */
  active: boolean;
  maxLatenessMinutes: number;
};

type ProspectSequence = { closed: boolean; reason: string };
const ms = (iso: string | null) => iso ? new Date(iso).getTime() : NaN;

export function createContactDispatcher(deps: ContactDispatcherDeps) {
  const { config } = deps;
  const now = deps.now ?? (() => new Date());
  const log = deps.log ?? (line => console.log(line));
  const newClaimId = deps.newClaimId ?? (() => randomUUID());
  /** Verrous de ce process dont `send_draft`/`markSent` est en cours : jamais réconciliés pendant ce temps. */
  const activeClaims = new Set<string>();
  let running: Promise<DispatchScanReport> | null = null;
  let timer: ReturnType<typeof setInterval> | null = null;

  const service = () => createContactMessageService(deps.getDb(), { now, remoteDrafts: deps.remoteDrafts() });

  function prospectSequence(db: Db, prospectId: string): ProspectSequence {
    const row = db.prepare('SELECT p.contactability_status,ct.status FROM prospects p LEFT JOIN contact_tracking ct ON ct.prospect_id=p.id WHERE p.id=?')
      .get(prospectId) as { contactability_status: string; status: string | null } | undefined;
    if (!row) return { closed: true, reason: 'prospect_missing' };
    const dnc = row.contactability_status === 'do_not_contact';
    const closedByState = isContactSequenceClosed(row.status, false);
    return { closed: isContactSequenceClosed(row.status, dnc), reason: closedByState ? `prospect_state:${row.status}` : 'do_not_contact' };
  }
  /** Décision 29 appliquée par le dispatcher : annule les messages non verrouillés d'une séquence fermée. */
  function cancelIfClosed(db: Db, prospectId: string): number {
    const sequence = prospectSequence(db, prospectId);
    if (!sequence.closed) return 0;
    const result = cancelFutureContactMessages(db, { prospectId, reason: sequence.reason, actor: DISPATCH_ACTOR, at: now().toISOString() });
    if (result.cancelled) log(`[dispatch] prospect ${prospectId} : ${result.cancelled} message(s) annulé(s) (séquence fermée)`);
    return result.cancelled;
  }
  function writeAudit(db: Db, before: ContactMessageRecord, after: ContactMessageRecord | null, action: string, extra: Record<string, unknown>) {
    const snapshot = (m: ContactMessageRecord | null) => m ? { step: m.step, status: m.status, revision: m.revision, scheduled_at: m.scheduled_at } : null;
    db.prepare('INSERT INTO audit_log(id,actor_type,actor_id,actor_display,entity_type,entity_id,action,changed_fields,before_payload,after_payload,source_context) VALUES(?,?,?,?,?,?,?,?,?,?,?)')
      .run(randomUUID(), DISPATCH_ACTOR.type, DISPATCH_ACTOR.id ?? null, DISPATCH_ACTOR.display ?? null, 'contact_message', before.id, action, JSON.stringify([]),
        JSON.stringify(snapshot(before)), JSON.stringify({ ...snapshot(after), prospect_id: before.prospect_id, ...extra }), 'contact_dispatch');
  }

  /**
   * Échec d'envoi : `terminal` => retour `validated` (validation conservée, date effacée, revue humaine) ; sinon verrou relâché
   * pour un nouvel essai après backoff. Gardé par statut, révision et verrou (celui du dispatcher, ou aucun).
   */
  function recordFailure(db: Db, input: { message: ContactMessageRecord; claimId: string | null; code: string; terminal: boolean; countAttempt: boolean; clearRemoteDraft?: boolean; details?: Record<string, string | number | boolean | null> }): boolean {
    const { message, claimId, code, terminal } = input;
    return db.transaction(() => {
      const at = now().toISOString();
      const set = [
        terminal ? "status='validated',scheduled_at=NULL" : null,
        'dispatch_claim_id=NULL,dispatch_claimed_at=NULL,last_error_code=?,last_error_at=?',
        input.countAttempt ? 'dispatch_attempts=dispatch_attempts+1' : null,
        input.clearRemoteDraft ? 'remote_provider=NULL,remote_draft_id=NULL' : null
      ].filter(Boolean).join(',');
      const claimCondition = claimId ? 'dispatch_claim_id=?' : 'dispatch_claim_id IS NULL';
      const update = db.prepare(`UPDATE contact_messages SET ${set},updated_at=? WHERE id=? AND status='scheduled' AND revision=? AND ${claimCondition}`)
        .run(code, at, at, message.id, message.revision, ...(claimId ? [claimId] : []));
      if (update.changes !== 1) return false;
      const after = getContactMessageById(db, message.id) as ContactMessageRecord;
      appendContactMessageEvent(db, {
        messageId: message.id, type: 'send_failed', actor: DISPATCH_ACTOR, at, fromStatus: 'scheduled', toStatus: after.status, revision: message.revision,
        details: { code, terminal, retry: !terminal, attempts: after.dispatch_attempts, claim_id: claimId, ...(input.details ?? {}) }
      });
      if (terminal) writeAudit(db, message, after, 'message_send_failed', { code });
      log(`[dispatch] message ${message.id} (${message.step}) : échec ${code}${terminal ? ', retour à Validé' : ', nouvel essai prévu'}`);
      return true;
    }).immediate();
  }
  /** Issue inconnue : verrou conservé (aucun renvoi), réconciliation après `claimTtlMs`. */
  function recordUncertain(db: Db, message: ContactMessageRecord, claimId: string, code: string) {
    db.transaction(() => {
      const at = now().toISOString();
      const update = db.prepare("UPDATE contact_messages SET last_error_code=?,last_error_at=?,updated_at=? WHERE id=? AND status='scheduled' AND dispatch_claim_id=?")
        .run(dispatchCodes.outcomeUnknown, at, at, message.id, claimId);
      if (update.changes !== 1) return;
      appendContactMessageEvent(db, {
        messageId: message.id, type: 'send_failed', actor: DISPATCH_ACTOR, at, fromStatus: 'scheduled', toStatus: 'scheduled', revision: message.revision,
        details: { code, outcome_unknown: true, claim_id: claimId }
      });
      log(`[dispatch] message ${message.id} (${message.step}) : issue d'envoi inconnue (${code}), verrou conservé pour réconciliation`);
    }).immediate();
  }

  /**
   * Verrou atomique + revérifications, dans une transaction IMMEDIATE (écrivain unique, y compris entre process) :
   * `null` = plus éligible (autre passe, édition, déprogrammation…), `'cancelled'` = séquence fermée entre-temps.
   */
  function claim(db: Db, seen: ContactMessageRecord): { claimId: string; draftId: string; message: ContactMessageRecord } | 'cancelled' | null {
    return db.transaction(() => {
      const at = now();
      const m = getContactMessageById(db, seen.id);
      if (!m || m.status !== 'scheduled' || m.dispatch_claim_id || m.revision !== seen.revision || m.validated_revision !== m.revision) return null;
      if (!m.remote_draft_id || m.remote_draft_id !== seen.remote_draft_id || m.dispatch_attempts !== seen.dispatch_attempts) return null;
      if (!(ms(m.scheduled_at) <= at.getTime()) || !m.to_recipients.length) return null;
      if (prospectSequence(db, m.prospect_id).closed) return cancelIfClosed(db, m.prospect_id) ? 'cancelled' : null;
      const claimId = newClaimId();
      const update = db.prepare(`UPDATE contact_messages SET dispatch_claim_id=?,dispatch_claimed_at=?,dispatch_attempts=dispatch_attempts+1,updated_at=?
        WHERE id=? AND status='scheduled' AND dispatch_claim_id IS NULL AND revision=? AND validated_revision=revision AND remote_draft_id=? AND dispatch_attempts=?
        AND julianday(scheduled_at)<=julianday(?)`)
        .run(claimId, at.toISOString(), at.toISOString(), m.id, m.revision, m.remote_draft_id, m.dispatch_attempts, at.toISOString());
      if (update.changes !== 1) return null;
      appendContactMessageEvent(db, {
        messageId: m.id, type: 'dispatch_claimed', actor: DISPATCH_ACTOR, at: at.toISOString(), fromStatus: 'scheduled', toStatus: 'scheduled', revision: m.revision,
        details: { claim_id: claimId, attempt: m.dispatch_attempts + 1, provider: m.remote_provider }
      });
      return { claimId, draftId: m.remote_draft_id, message: getContactMessageById(db, m.id) as ContactMessageRecord };
    }).immediate();
  }

  async function dispatchOne(toolbox: MailToolbox, id: string, report: DispatchScanReport) {
    let db = deps.getDb();
    let message = getContactMessageById(db, id);
    const at = now();
    if (!message || message.status !== 'scheduled' || message.dispatch_claim_id || !(ms(message.scheduled_at) <= at.getTime())) return;
    if (prospectSequence(db, message.prospect_id).closed) { report.cancelled += cancelIfClosed(db, message.prospect_id); return; }
    if (at.getTime() - ms(message.scheduled_at) > config.maxLatenessMs) {
      if (recordFailure(db, { message, claimId: null, code: dispatchCodes.overdue, terminal: true, countAttempt: false })) { report.overdue++; report.failed++; }
      return;
    }
    if (message.last_error_at && at.getTime() - ms(message.last_error_at) < dispatchBackoffMs(message.dispatch_attempts, config.retryBaseMs)) { report.deferred++; return; }
    if (!message.to_recipients.length) {
      if (recordFailure(db, { message, claimId: null, code: dispatchCodes.missingRecipients, terminal: true, countAttempt: false })) report.failed++;
      return;
    }
    if (!message.remote_draft_id) {
      // Validé/programmé pendant une déconnexion ou création échouée : brouillon Infomaniak créé maintenant (jamais envoyé ici).
      const sync = await service().syncRemoteDraft(id, DISPATCH_ACTOR);
      db = deps.getDb();
      if (sync.status === 'failed') {
        const current = getContactMessageById(db, id);
        if (!current || current.status !== 'scheduled' || current.dispatch_claim_id) return;
        const outcome = classifyDraftError(sync.code);
        const terminal = outcome.kind === 'terminal' || current.dispatch_attempts + 1 >= config.maxAttempts;
        if (recordFailure(db, { message: current, claimId: null, code: outcome.code, terminal, countAttempt: true, details: { stage: 'create_draft' } })) {
          if (terminal) report.failed++; else report.retrying++;
        }
        return;
      }
      message = getContactMessageById(db, id);
      if (!message || !message.remote_draft_id) { report.deferred++; return; }
    }

    const claimed = claim(db, message);
    if (claimed === 'cancelled') { report.cancelled++; return; }
    if (!claimed) return;
    const { claimId } = claimed;
    activeClaims.add(claimId);
    try {
      let sendError: unknown = null;
      let sent = false;
      try {
        await toolbox.sendDraft(claimed.draftId);
        sent = true;
      } catch (e) { sendError = e; }
      db = deps.getDb();
      if (sent) {
        try {
          service().markSent(id, { claimId, remoteMessageId: null }, DISPATCH_ACTOR);
          report.sent++;
          log(`[dispatch] message ${id} (${claimed.message.step}) : envoyé`);
        } catch (e) {
          // Parti mais non enregistré (base restaurée, disque plein…) : le verrou reste, la réconciliation conclura sans renvoyer.
          report.uncertain++;
          log(`[dispatch] message ${id} : envoyé mais statut non enregistré (${e instanceof Error && 'code' in e ? String(e.code) : 'erreur interne'}), réconciliation à venir`);
        }
        return;
      }
      const current = getContactMessageById(db, id);
      if (!current || current.dispatch_claim_id !== claimId) { report.uncertain++; return; }
      const outcome = classifySendError(sendError);
      if (outcome.kind === 'uncertain') { recordUncertain(db, current, claimId, outcome.code); report.uncertain++; return; }
      const terminal = outcome.kind === 'terminal' || current.dispatch_attempts >= config.maxAttempts;
      if (recordFailure(db, { message: current, claimId, code: outcome.code, terminal, countAttempt: false, clearRemoteDraft: outcome.code === 'toolbox_draft_not_found' })) {
        if (terminal) report.failed++; else report.retrying++;
      }
      // Changement d'état prospect pendant l'appel (message alors `inFlight`, non annulé) : annulation maintenant qu'il est relâché.
      report.cancelled += cancelIfClosed(db, current.prospect_id);
    } finally {
      activeClaims.delete(claimId);
    }
  }

  /** Verrous orphelins : jamais relancés ; `list_drafts` décide entre « envoyé » et « revue humaine ». */
  async function reconcile(toolbox: MailToolbox, report: DispatchScanReport) {
    const cutoff = now().getTime() - config.claimTtlMs;
    const stale = (deps.getDb().prepare("SELECT id,dispatch_claim_id,dispatch_claimed_at FROM contact_messages WHERE status='scheduled' AND dispatch_claim_id IS NOT NULL")
      .all() as { id: string; dispatch_claim_id: string; dispatch_claimed_at: string }[])
      .filter(row => !activeClaims.has(row.dispatch_claim_id) && ms(row.dispatch_claimed_at) <= cutoff);
    if (!stale.length) return;
    let drafts: ToolboxDraftSummary[];
    try {
      drafts = await toolbox.listDrafts(RECONCILE_LIST_LIMIT);
    } catch (e) {
      report.deferred += stale.length;
      log(`[dispatch] réconciliation reportée : liste des brouillons indisponible (${e instanceof ToolboxError ? e.code : 'erreur interne'})`);
      return;
    }
    const db = deps.getDb();
    for (const row of stale) {
      const message = getContactMessageById(db, row.id);
      if (!message || message.status !== 'scheduled' || message.dispatch_claim_id !== row.dispatch_claim_id || activeClaims.has(row.dispatch_claim_id)) continue;
      const present = Boolean(message.remote_draft_id) && drafts.some(d => d.draftId === message.remote_draft_id);
      if (present) {
        if (recordFailure(db, { message, claimId: row.dispatch_claim_id, code: dispatchCodes.notConfirmed, terminal: true, countAttempt: false, details: { reconciled: true, remote_draft: 'present' } })) {
          report.reconciledNotSent++;
          report.cancelled += cancelIfClosed(db, message.prospect_id);
        }
      } else if (drafts.length >= RECONCILE_LIST_LIMIT || !message.remote_draft_id) {
        // Liste tronquée : l'absence ne prouve rien. Le verrou reste, nouvel essai à la passe suivante.
        if (message.last_error_code !== dispatchCodes.outcomeUnknown) recordUncertain(db, message, row.dispatch_claim_id, 'reconcile_inconclusive');
        report.uncertain++;
      } else {
        try {
          createContactMessageService(db, { now }).markSent(message.id, { claimId: row.dispatch_claim_id, remoteMessageId: null, reconciled: true }, DISPATCH_ACTOR);
          report.reconciledSent++;
          log(`[dispatch] message ${message.id} (${message.step}) : envoi confirmé par réconciliation (brouillon distant disparu)`);
        } catch {
          report.uncertain++;
        }
      }
    }
  }

  async function scan(): Promise<DispatchScanReport> {
    const toolbox = deps.toolbox();
    if (!toolbox) return emptyReport('inactive');
    const report = emptyReport();
    await reconcile(toolbox, report);
    const due = deps.getDb().prepare("SELECT id FROM contact_messages WHERE status='scheduled' AND dispatch_claim_id IS NULL AND julianday(scheduled_at)<=julianday(?) ORDER BY julianday(scheduled_at),rowid LIMIT ?")
      .all(now().toISOString(), config.batchSize) as { id: string }[];
    for (const { id } of due) await dispatchOne(toolbox, id, report);
    return report;
  }

  const dispatcher = {
    /** Une passe complète ; un appel pendant une passe en cours renvoie la même passe (aucun chevauchement). */
    runScan(): Promise<DispatchScanReport> {
      running ??= scan()
        .catch(e => {
          log(`[dispatch] passe en échec : ${e instanceof ToolboxError ? e.code : e instanceof Error ? e.name : 'erreur interne'}`);
          return emptyReport('error');
        })
        .finally(() => { running = null; });
      return running;
    },
    start() {
      if (!config.intervalMs || timer) return;
      timer = setInterval(() => { void dispatcher.runScan(); }, config.intervalMs);
      timer.unref?.();
      void dispatcher.runScan();
    },
    /** Arrête le scan périodique ; la promesse se résout quand la passe en cours (envoi compris) est terminée. */
    async stop() {
      if (timer) clearInterval(timer);
      timer = null;
      if (running) await running;
    },
    status: (): ContactDispatchStatus => ({ active: timer !== null && deps.toolbox() !== null, maxLatenessMinutes: Math.round(config.maxLatenessMs / 60_000) })
  };
  return dispatcher;
}
export type ContactDispatcher = ReturnType<typeof createContactDispatcher>;
