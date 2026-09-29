// Repository typé des messages Contact/R1/R2 (Task 11) : lecture, création d'un brouillon, journal par message et annulation
// mécanique des messages futurs (décision 29). Les transitions éditer/valider/programmer/envoyer sont la machine d'état de la
// Task 12 et le dispatch la Task 16 ; les invariants SQL de `contactMessageSchema.ts` s'appliquent à toutes les écritures.
// Aucune donnée de message (sujet, corps, destinataires, from) n'est écrite dans le journal ni dans `audit_log`.
import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import type { Actor } from './audit.js';
import type { FutureMessageCanceller } from './contactTrackingService.js';
import {
  cancellableContactMessageStatuses, contactMessageSteps, DEFAULT_CONTACT_MESSAGE_STATUS,
  type ContactMessageEventType, type ContactMessageStatus, type ContactMessageStep
} from '../shared/contactWorkflow.js';

type Db = Database.Database;

export type ContactMessageRecord = {
  id: string; prospect_id: string; step: ContactMessageStep; status: ContactMessageStatus;
  from_email: string | null; subject: string; body_text: string;
  to_recipients: string[]; cc_recipients: string[]; bcc_recipients: string[];
  revision: number; scheduled_at: string | null;
  validated_at: string | null; validated_by_actor_id: string | null; validated_revision: number | null;
  sent_at: string | null; cancelled_at: string | null; cancel_reason: string | null;
  remote_provider: string | null; remote_draft_id: string | null; remote_message_id: string | null;
  dispatch_claim_id: string | null; dispatch_claimed_at: string | null; dispatch_attempts: number;
  last_error_code: string | null; last_error_at: string | null;
  generation_model: string | null; generation_prompt_version: string | null;
  created_at: string; updated_at: string;
};
export type ContactMessageEventRecord = {
  id: string; message_id: string; event_type: ContactMessageEventType; from_status: ContactMessageStatus | null; to_status: ContactMessageStatus | null;
  revision: number | null; actor_type: Actor['type']; actor_id: string | null; details: Record<string, unknown>; created_at: string;
};

type Row = Omit<ContactMessageRecord, 'to_recipients' | 'cc_recipients' | 'bcc_recipients'> & { to_recipients_json: string; cc_recipients_json: string; bcc_recipients_json: string };
const toRecord = ({ to_recipients_json, cc_recipients_json, bcc_recipients_json, ...row }: Row): ContactMessageRecord => ({
  ...row, to_recipients: JSON.parse(to_recipients_json), cc_recipients: JSON.parse(cc_recipients_json), bcc_recipients: JSON.parse(bcc_recipients_json)
});
const stepOrderSql = `CASE step ${contactMessageSteps.map((step, i) => `WHEN '${step}' THEN ${i}`).join(' ')} END`;
const CANCELLABLE = cancellableContactMessageStatuses.map(s => `'${s}'`).join(',');

export const getContactMessageById = (db: Db, id: string): ContactMessageRecord | null => {
  const row = db.prepare('SELECT * FROM contact_messages WHERE id=?').get(id) as Row | undefined;
  return row ? toRecord(row) : null;
};
export const getContactMessage = (db: Db, prospectId: string, step: ContactMessageStep): ContactMessageRecord | null => {
  const row = db.prepare('SELECT * FROM contact_messages WHERE prospect_id=? AND step=?').get(prospectId, step) as Row | undefined;
  return row ? toRecord(row) : null;
};
/** Messages d'un prospect dans l'ordre Contact, R1, R2. */
export const listContactMessages = (db: Db, prospectId: string): ContactMessageRecord[] =>
  (db.prepare(`SELECT * FROM contact_messages WHERE prospect_id=? ORDER BY ${stepOrderSql}`).all(prospectId) as Row[]).map(toRecord);

// --- Journal ---
/** Clés refusées dans les détails d'un événement : le contenu du message reste dans `contact_messages` uniquement. */
const forbiddenDetailKey = /subject|body|recipient|^(to|cc|bcc|from|from_email|email|address)$/i;
export type ContactMessageEventInput = {
  messageId: string; type: ContactMessageEventType; actor: Actor; at: string;
  fromStatus?: ContactMessageStatus | null; toStatus?: ContactMessageStatus | null; revision?: number | null;
  details?: Record<string, string | number | boolean | null>;
};
export function appendContactMessageEvent(db: Db, event: ContactMessageEventInput): string {
  const details = event.details ?? {};
  const leaked = Object.keys(details).filter(key => forbiddenDetailKey.test(key));
  if (leaked.length) throw new Error(`Détail d'événement message refusé (contenu du message) : ${leaked.join(', ')}`);
  const id = randomUUID();
  db.prepare('INSERT INTO contact_message_events(id,message_id,event_type,from_status,to_status,revision,actor_type,actor_id,details_json,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)')
    .run(id, event.messageId, event.type, event.fromStatus ?? null, event.toStatus ?? null, event.revision ?? null, event.actor.type, event.actor.id ?? null, JSON.stringify(details), event.at);
  return id;
}
export const listContactMessageEvents = (db: Db, messageId: string): ContactMessageEventRecord[] =>
  (db.prepare('SELECT * FROM contact_message_events WHERE message_id=? ORDER BY created_at,rowid').all(messageId) as (Omit<ContactMessageEventRecord, 'details'> & { details_json: string })[])
    .map(({ details_json, ...row }) => ({ ...row, details: JSON.parse(details_json) }));

// --- Création ---
export type NewContactMessage = {
  prospectId: string; step: ContactMessageStep; actor: Actor; at: string;
  fromEmail?: string | null; subject?: string; bodyText?: string; to?: string[]; cc?: string[]; bcc?: string[];
  /** Présent = texte produit par l'IA (événement `generated`), sinon saisie manuelle (`created`). */
  generation?: { model: string; promptVersion: string };
};
/** Crée le message d'une étape, toujours en `draft` (décision 22). Lève une erreur SQLite UNIQUE si l'étape existe déjà. */
export function createContactMessage(db: Db, input: NewContactMessage): ContactMessageRecord {
  const id = randomUUID();
  db.transaction(() => {
    db.prepare(`INSERT INTO contact_messages(id,prospect_id,step,status,from_email,subject,body_text,to_recipients_json,cc_recipients_json,bcc_recipients_json,generation_model,generation_prompt_version,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(id, input.prospectId, input.step, DEFAULT_CONTACT_MESSAGE_STATUS, input.fromEmail ?? null, input.subject ?? '', input.bodyText ?? '',
        JSON.stringify(input.to ?? []), JSON.stringify(input.cc ?? []), JSON.stringify(input.bcc ?? []),
        input.generation?.model ?? null, input.generation?.promptVersion ?? null, input.at, input.at);
    appendContactMessageEvent(db, {
      messageId: id, type: input.generation ? 'generated' : 'created', actor: input.actor, at: input.at, toStatus: DEFAULT_CONTACT_MESSAGE_STATUS, revision: 1,
      details: { step: input.step, ...(input.generation ? { model: input.generation.model, prompt_version: input.generation.promptVersion } : {}) }
    });
  })();
  return getContactMessageById(db, id) as ContactMessageRecord;
}

// --- Annulation des messages futurs (décision 29) ---
export type FutureContactMessagesCancellation = {
  cancelled: number;
  cancelledIds: string[];
  /** Messages programmés verrouillés par un envoi en cours : laissés au dispatcher (Task 16), qui doit vérifier l'état prospect. */
  inFlight: number;
  /** Brouillons distants mis en file de suppression (`contact_message_remote_draft_cleanups`), supprimés après commit. */
  remoteDraftsQueued: number;
};
/**
 * Annule en SQL pur tous les messages `draft`/`validated`/`scheduled` non verrouillés d'un prospect ; `sent` et `cancelled`
 * intacts. Transactionnelle (savepoint si appelée dans une transaction, ex. le changement d'état du suivi).
 */
export function cancelFutureContactMessages(db: Db, input: { prospectId: string; reason: string; actor: Actor; at: string }): FutureContactMessagesCancellation {
  return db.transaction(() => {
    const candidates = db.prepare(`SELECT id,status,revision,remote_provider,remote_draft_id,dispatch_claim_id FROM contact_messages WHERE prospect_id=? AND status IN (${CANCELLABLE}) ORDER BY ${stepOrderSql}`)
      .all(input.prospectId) as { id: string; status: ContactMessageStatus; revision: number; remote_provider: string | null; remote_draft_id: string | null; dispatch_claim_id: string | null }[];
    const queue = db.prepare("INSERT OR IGNORE INTO contact_message_remote_draft_cleanups(id,message_id,remote_provider,remote_draft_id,reason,created_at) VALUES(?,?,?,?,'cancelled',?)");
    const cancel = db.prepare("UPDATE contact_messages SET status='cancelled',cancelled_at=?,cancel_reason=?,remote_draft_id=NULL,updated_at=? WHERE id=? AND status=? AND dispatch_claim_id IS NULL");
    const result: FutureContactMessagesCancellation = { cancelled: 0, cancelledIds: [], inFlight: 0, remoteDraftsQueued: 0 };
    for (const message of candidates) {
      if (message.dispatch_claim_id) { result.inFlight++; continue; }
      const remoteQueued = Boolean(message.remote_draft_id && message.remote_provider);
      if (remoteQueued) queue.run(randomUUID(), message.id, message.remote_provider, message.remote_draft_id, input.at);
      cancel.run(input.at, input.reason, input.at, message.id, message.status);
      appendContactMessageEvent(db, {
        messageId: message.id, type: 'cancelled', actor: input.actor, at: input.at, fromStatus: message.status, toStatus: 'cancelled',
        revision: message.revision, details: { reason: input.reason, remote_draft_queued: remoteQueued }
      });
      result.cancelled++;
      result.cancelledIds.push(message.id);
      if (remoteQueued) result.remoteDraftsQueued++;
    }
    return result;
  })();
}

/** Implémentation du hook `cancelFutureMessages` du service de suivi (appelée dans sa transaction). */
export const contactMessageCanceller: FutureMessageCanceller = ({ db, prospectId, toState, actor, at }) =>
  cancelFutureContactMessages(db, { prospectId, reason: `prospect_state:${toState}`, actor, at });
