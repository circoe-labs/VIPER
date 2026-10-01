import { randomUUID } from 'node:crypto';
import { cancellableContactMessageStatuses, contactMessageSteps, DEFAULT_CONTACT_MESSAGE_STATUS } from '../shared/contactWorkflow.js';
const toRecord = ({ to_recipients_json, cc_recipients_json, bcc_recipients_json, ...row }) => ({
    ...row, to_recipients: JSON.parse(to_recipients_json), cc_recipients: JSON.parse(cc_recipients_json), bcc_recipients: JSON.parse(bcc_recipients_json)
});
const stepOrderSql = `CASE step ${contactMessageSteps.map((step, i) => `WHEN '${step}' THEN ${i}`).join(' ')} END`;
const CANCELLABLE = cancellableContactMessageStatuses.map(s => `'${s}'`).join(',');
export const getContactMessageById = (db, id) => {
    const row = db.prepare('SELECT * FROM contact_messages WHERE id=?').get(id);
    return row ? toRecord(row) : null;
};
export const getContactMessage = (db, prospectId, step) => {
    const row = db.prepare('SELECT * FROM contact_messages WHERE prospect_id=? AND step=?').get(prospectId, step);
    return row ? toRecord(row) : null;
};
/** Messages d'un prospect dans l'ordre Contact, R1, R2. */
export const listContactMessages = (db, prospectId) => db.prepare(`SELECT * FROM contact_messages WHERE prospect_id=? ORDER BY ${stepOrderSql}`).all(prospectId).map(toRecord);
// --- Journal ---
/** Clés refusées dans les détails d'un événement : le contenu du message reste dans `contact_messages` uniquement. */
const forbiddenDetailKey = /subject|body|recipient|^(to|cc|bcc|from|from_email|email|address)$/i;
export function appendContactMessageEvent(db, event) {
    const details = event.details ?? {};
    const leaked = Object.keys(details).filter(key => forbiddenDetailKey.test(key));
    if (leaked.length)
        throw new Error(`Détail d'événement message refusé (contenu du message) : ${leaked.join(', ')}`);
    const id = randomUUID();
    db.prepare('INSERT INTO contact_message_events(id,message_id,event_type,from_status,to_status,revision,actor_type,actor_id,details_json,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)')
        .run(id, event.messageId, event.type, event.fromStatus ?? null, event.toStatus ?? null, event.revision ?? null, event.actor.type, event.actor.id ?? null, JSON.stringify(details), event.at);
    return id;
}
export const listContactMessageEvents = (db, messageId) => db.prepare('SELECT * FROM contact_message_events WHERE message_id=? ORDER BY created_at,rowid').all(messageId)
    .map(({ details_json, ...row }) => ({ ...row, details: JSON.parse(details_json) }));
/** Crée le message d'une étape, toujours en `draft` (décision 22). Lève une erreur SQLite UNIQUE si l'étape existe déjà. */
export function createContactMessage(db, input) {
    const id = randomUUID();
    db.transaction(() => {
        db.prepare(`INSERT INTO contact_messages(id,prospect_id,step,status,from_email,subject,body_text,to_recipients_json,cc_recipients_json,bcc_recipients_json,generation_model,generation_prompt_version,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
            .run(id, input.prospectId, input.step, DEFAULT_CONTACT_MESSAGE_STATUS, input.fromEmail ?? null, input.subject ?? '', input.bodyText ?? '', JSON.stringify(input.to ?? []), JSON.stringify(input.cc ?? []), JSON.stringify(input.bcc ?? []), input.generation?.model ?? null, input.generation?.promptVersion ?? null, input.at, input.at);
        appendContactMessageEvent(db, {
            messageId: id, type: input.generation ? 'generated' : 'created', actor: input.actor, at: input.at, toStatus: DEFAULT_CONTACT_MESSAGE_STATUS, revision: 1,
            details: { step: input.step, ...(input.generation ? { model: input.generation.model, prompt_version: input.generation.promptVersion } : {}) }
        });
    })();
    return getContactMessageById(db, id);
}
/**
 * Annule en SQL pur tous les messages `draft`/`validated`/`scheduled` non verrouillés d'un prospect ; `sent` et `cancelled`
 * intacts. Transactionnelle (savepoint si appelée dans une transaction, ex. le changement d'état du suivi).
 */
export function cancelFutureContactMessages(db, input) {
    return db.transaction(() => {
        const candidates = db.prepare(`SELECT id,status,revision,remote_provider,remote_draft_id,dispatch_claim_id FROM contact_messages WHERE prospect_id=? AND status IN (${CANCELLABLE}) ORDER BY ${stepOrderSql}`)
            .all(input.prospectId);
        const queue = db.prepare("INSERT OR IGNORE INTO contact_message_remote_draft_cleanups(id,message_id,remote_provider,remote_draft_id,reason,created_at) VALUES(?,?,?,?,'cancelled',?)");
        const cancel = db.prepare("UPDATE contact_messages SET status='cancelled',cancelled_at=?,cancel_reason=?,remote_draft_id=NULL,updated_at=? WHERE id=? AND status=? AND dispatch_claim_id IS NULL");
        const result = { cancelled: 0, cancelledIds: [], inFlight: 0, remoteDraftsQueued: 0 };
        for (const message of candidates) {
            if (message.dispatch_claim_id) {
                result.inFlight++;
                continue;
            }
            const remoteQueued = Boolean(message.remote_draft_id && message.remote_provider);
            if (remoteQueued)
                queue.run(randomUUID(), message.id, message.remote_provider, message.remote_draft_id, input.at);
            cancel.run(input.at, input.reason, input.at, message.id, message.status);
            appendContactMessageEvent(db, {
                messageId: message.id, type: 'cancelled', actor: input.actor, at: input.at, fromStatus: message.status, toStatus: 'cancelled',
                revision: message.revision, details: { reason: input.reason, remote_draft_queued: remoteQueued }
            });
            result.cancelled++;
            result.cancelledIds.push(message.id);
            if (remoteQueued)
                result.remoteDraftsQueued++;
        }
        return result;
    })();
}
/** Implémentation du hook `cancelFutureMessages` du service de suivi (appelée dans sa transaction). */
export const contactMessageCanceller = ({ db, prospectId, toState, actor, at }) => cancelFutureContactMessages(db, { prospectId, reason: `prospect_state:${toState}`, actor, at });
