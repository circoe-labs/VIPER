import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { appendContactMessageEvent, createContactMessage, getContactMessage, getContactMessageById, listContactMessageEvents, listContactMessages } from './contactMessageStore.js';
import { contactMessageSteps, contactMessageStepSchema, isCancellableContactMessage, isContactSequenceClosed } from '../shared/contactWorkflow.js';
// --- Erreurs métier typées (code stable + statut HTTP) ---
export const contactMessageErrorStatus = {
    prospect_not_found: 404,
    message_not_found: 404,
    invalid_step: 400,
    invalid_payload: 400,
    invalid_recipient: 400,
    invalid_from_email: 400,
    invalid_scheduled_at: 400,
    scheduled_at_not_future: 400,
    revision_required: 400,
    human_actor_required: 403,
    revision_conflict: 409,
    message_exists: 409,
    message_sent_immutable: 409,
    message_cancelled: 409,
    invalid_transition: 409,
    dispatch_in_progress: 409,
    dispatch_claim_mismatch: 409,
    prospect_do_not_contact: 409,
    prospect_sequence_closed: 409,
    message_incomplete: 422
};
export class ContactMessageError extends Error {
    code;
    httpStatus;
    /** Champs manquants (`message_incomplete`) : noms de champs seulement. */
    fields;
    constructor(code, message, fields) {
        super(message);
        this.name = 'ContactMessageError';
        this.code = code;
        this.httpStatus = contactMessageErrorStatus[code];
        if (fields)
            this.fields = fields;
    }
}
/** Diagnostic d'un envoi déduit par réconciliation (issue incertaine, brouillon distant disparu) : voir `markSent`. */
export const SENT_RECONCILED_CODE = 'send_reconciled_draft_absent';
export const noRemoteDrafts = { createDraft: async () => null };
// --- Schémas d'entrée (routes) ---
const revision = z.number().int().min(1);
const emailSchema = z.string().trim().pipe(z.email());
const recipients = z.array(z.string()).max(50);
/** Corps de `PUT /api/prospects/:id/messages/:step` : contenu seulement ; aucun statut, date ou validation (strict). */
export const messageContentSchema = z.object({
    expected_revision: revision.nullable().optional(),
    from_email: z.string().max(320).nullable().optional(),
    subject: z.string().max(998).optional(),
    body_text: z.string().max(100000).optional(),
    to: recipients.optional(),
    cc: recipients.optional(),
    bcc: recipients.optional()
}).strict();
const revisionOnlySchema = z.object({ expected_revision: revision }).strict();
const scheduleSchema = z.object({ expected_revision: revision, scheduled_at: z.string() }).strict();
/** Contenu produit par l'IA (Task 14) : sujet/corps seulement, jamais de statut. */
export const generatedContentSchema = z.object({
    subject: z.string().max(998), body_text: z.string().max(100000),
    model: z.string().trim().min(1).max(200), prompt_version: z.string().trim().min(1).max(200),
    expected_revision: revision.nullable().optional()
}).strict();
function parse(schema, body) {
    const parsed = schema.safeParse(body ?? {});
    if (parsed.success)
        return parsed.data;
    const field = String(parsed.error.issues[0]?.path[0] ?? '');
    if (field === 'expected_revision')
        throw new ContactMessageError('revision_required', 'Révision attendue manquante ou invalide');
    if (field === 'scheduled_at')
        throw new ContactMessageError('invalid_scheduled_at', 'Date/heure d’envoi invalide');
    throw new ContactMessageError('invalid_payload', 'Données du message invalides');
}
export const parseMessageStep = (value) => {
    const parsed = contactMessageStepSchema.safeParse(value);
    if (!parsed.success)
        throw new ContactMessageError('invalid_step', 'Étape de message invalide');
    return parsed.data;
};
export const parseMessageContent = (body) => parse(messageContentSchema, body);
export const parseExpectedRevision = (body) => parse(revisionOnlySchema, body).expected_revision;
export const parseSchedule = (body) => parse(scheduleSchema, body);
export const parseGeneratedContent = (body) => parse(generatedContentSchema, body);
const isEmail = (value) => emailSchema.safeParse(value).success;
const isHuman = (actor) => actor.type === 'human' && Boolean(actor.id);
/** Adresses nettoyées (trim, dédoublonnées sans casse) ; une adresse invalide est refusée, jamais ignorée en silence. */
function normalizeRecipients(values) {
    const out = [];
    for (const raw of values) {
        const value = raw.trim();
        if (!value)
            continue;
        if (!isEmail(value))
            throw new ContactMessageError('invalid_recipient', 'Adresse destinataire invalide');
        if (!out.some(v => v.toLowerCase() === value.toLowerCase()))
            out.push(value);
    }
    return out;
}
function normalizeFrom(value) {
    const from = (value ?? '').trim();
    if (!from)
        return null;
    if (!isEmail(from))
        throw new ContactMessageError('invalid_from_email', 'Adresse d’expéditeur invalide');
    return from;
}
const contentFields = ['from_email', 'subject', 'body_text', 'to_recipients', 'cc_recipients', 'bcc_recipients'];
const sameValue = (a, b) => JSON.stringify(a) === JSON.stringify(b);
export function createContactMessageService(db, deps = {}) {
    const now = deps.now ?? (() => new Date());
    const remoteDrafts = deps.remoteDrafts ?? noRemoteDrafts;
    const defaultFrom = deps.defaultFromEmail && isEmail(deps.defaultFromEmail.trim()) ? deps.defaultFromEmail.trim() : null;
    function loadContext(prospectId) {
        const row = db.prepare('SELECT p.id,p.contactability_status,ct.status FROM prospects p LEFT JOIN contact_tracking ct ON ct.prospect_id=p.id WHERE p.id=?')
            .get(prospectId);
        if (!row)
            throw new ContactMessageError('prospect_not_found', 'Prospect introuvable');
        const doNotContact = row.contactability_status === 'do_not_contact';
        return { id: row.id, state: row.status, do_not_contact: doNotContact, sequence_closed: isContactSequenceClosed(row.status, doNotContact) };
    }
    function defaultsFor(prospectId) {
        const primary = db.prepare('SELECT address FROM emails WHERE prospect_id=? AND is_primary=1 AND is_active=1').get(prospectId);
        return { from_email: defaultFrom, to: primary && isEmail(primary.address.trim()) ? [primary.address.trim()] : [] };
    }
    function requireOpenSequence(context) {
        if (context.do_not_contact)
            throw new ContactMessageError('prospect_do_not_contact', 'Prospect à ne plus contacter : aucun message possible');
        if (context.sequence_closed)
            throw new ContactMessageError('prospect_sequence_closed', 'Séquence fermée par l’état du prospect : aucun message possible');
    }
    const requireHuman = (actor) => {
        if (!isHuman(actor))
            throw new ContactMessageError('human_actor_required', 'Action humaine authentifiée requise');
    };
    function requireMessage(prospectId, step) {
        const message = getContactMessage(db, prospectId, step);
        if (!message)
            throw new ContactMessageError('message_not_found', 'Message introuvable');
        return message;
    }
    function requireRevision(message, expected) {
        if (expected === undefined || expected === null)
            throw new ContactMessageError('revision_required', 'Révision attendue manquante');
        if (expected !== message.revision)
            throw new ContactMessageError('revision_conflict', 'Le message a été modifié entre-temps : recharger avant de continuer');
    }
    const requireNotSent = (message) => {
        if (message.status === 'sent')
            throw new ContactMessageError('message_sent_immutable', 'Un message envoyé ne peut plus être modifié');
    };
    const requireNotClaimed = (message) => {
        if (message.dispatch_claim_id)
            throw new ContactMessageError('dispatch_in_progress', 'Envoi en cours : message verrouillé');
    };
    const invalidTransition = (from, action) => new ContactMessageError('invalid_transition', `Action « ${action} » impossible depuis le statut ${from}`);
    function writeAudit(actor, message, action, before, extra = {}) {
        const snapshot = (m) => m ? { step: m.step, status: m.status, revision: m.revision, scheduled_at: m.scheduled_at ?? null } : null;
        db.prepare('INSERT INTO audit_log(id,actor_type,actor_id,actor_display,entity_type,entity_id,action,changed_fields,before_payload,after_payload,source_context) VALUES(?,?,?,?,?,?,?,?,?,?,?)')
            .run(randomUUID(), actor.type, actor.id ?? null, actor.display ?? null, 'contact_message', message.id, action, JSON.stringify([]), JSON.stringify(snapshot(before)), JSON.stringify({ ...snapshot(message), prospect_id: message.prospect_id, ...extra }), 'contact');
    }
    function queueRemoteCleanup(message, reason, at) {
        if (!message.remote_draft_id || !message.remote_provider)
            return false;
        db.prepare('INSERT OR IGNORE INTO contact_message_remote_draft_cleanups(id,message_id,remote_provider,remote_draft_id,reason,created_at) VALUES(?,?,?,?,?,?)')
            .run(randomUUID(), message.id, message.remote_provider, message.remote_draft_id, reason, at);
        return true;
    }
    const result = (message, flags = {}) => ({ message, created: false, changed: true, unvalidated: false, remoteDraftQueued: false, ...flags });
    // Édition du contenu d'un message existant (manuelle ou générée) : cœur unique de la règle « édition => revalidation ».
    function editContent(existing, next, actor, at, generation) {
        requireNotSent(existing);
        if (existing.status === 'cancelled')
            throw new ContactMessageError('message_cancelled', 'Message annulé : le rouvrir avant de le modifier');
        const changedFields = contentFields.filter(key => !sameValue(existing[key], next[key]));
        if (!changedFields.length && !generation)
            return result(existing, { changed: false });
        requireNotClaimed(existing);
        const wasValidated = existing.status === 'validated' || existing.status === 'scheduled';
        const revisionNext = existing.revision + 1;
        const remoteDraftQueued = wasValidated && queueRemoteCleanup(existing, 'edited', at);
        const update = db.prepare(`UPDATE contact_messages SET status='draft',from_email=?,subject=?,body_text=?,to_recipients_json=?,cc_recipients_json=?,bcc_recipients_json=?,
      revision=?,scheduled_at=NULL,validated_at=NULL,validated_by_actor_id=NULL,validated_revision=NULL,remote_provider=NULL,remote_draft_id=NULL,
      generation_model=?,generation_prompt_version=?,updated_at=? WHERE id=? AND revision=?`)
            .run(next.from_email, next.subject, next.body_text, JSON.stringify(next.to_recipients), JSON.stringify(next.cc_recipients), JSON.stringify(next.bcc_recipients), revisionNext, generation?.model ?? existing.generation_model, generation?.promptVersion ?? existing.generation_prompt_version, at, existing.id, existing.revision);
        if (update.changes !== 1)
            throw new ContactMessageError('revision_conflict', 'Le message a été modifié entre-temps : recharger avant de continuer');
        const fields = changedFields.join(',');
        if (wasValidated) {
            appendContactMessageEvent(db, { messageId: existing.id, type: 'unvalidated_by_edit', actor, at, fromStatus: existing.status, toStatus: 'draft', revision: revisionNext, details: { fields, had_schedule: existing.status === 'scheduled' } });
        }
        if (remoteDraftQueued) {
            appendContactMessageEvent(db, { messageId: existing.id, type: 'remote_draft_invalidated', actor, at, fromStatus: existing.status, toStatus: 'draft', revision: revisionNext, details: { provider: existing.remote_provider, reason: 'edited' } });
        }
        appendContactMessageEvent(db, generation
            ? { messageId: existing.id, type: 'generated', actor, at, fromStatus: existing.status, toStatus: 'draft', revision: revisionNext, details: { model: generation.model, prompt_version: generation.promptVersion } }
            : { messageId: existing.id, type: 'edited', actor, at, fromStatus: existing.status, toStatus: 'draft', revision: revisionNext, details: { fields } });
        const message = getContactMessageById(db, existing.id);
        writeAudit(actor, message, generation ? 'message_generate' : 'message_edit', existing, { unvalidated: wasValidated });
        return result(message, { unvalidated: wasValidated, remoteDraftQueued });
    }
    function contentFrom(input, base) {
        return {
            from_email: input.from_email !== undefined ? normalizeFrom(input.from_email) : base.from_email,
            subject: input.subject ?? base.subject,
            body_text: input.body_text ?? base.body_text,
            to_recipients: input.to ? normalizeRecipients(input.to) : base.to_recipients,
            cc_recipients: input.cc ? normalizeRecipients(input.cc) : base.cc_recipients,
            bcc_recipients: input.bcc ? normalizeRecipients(input.bcc) : base.bcc_recipients
        };
    }
    const defaultContent = (prospectId) => {
        const defaults = defaultsFor(prospectId);
        return { from_email: defaults.from_email, subject: '', body_text: '', to_recipients: defaults.to, cc_recipients: [], bcc_recipients: [] };
    };
    function create(prospectId, step, content, actor, at, generation) {
        const message = createContactMessage(db, {
            prospectId, step, actor, at, fromEmail: content.from_email, subject: content.subject, bodyText: content.body_text,
            to: content.to_recipients, cc: content.cc_recipients, bcc: content.bcc_recipients, ...(generation ? { generation } : {})
        });
        writeAudit(actor, message, generation ? 'message_generate' : 'message_create', null);
        return result(message, { created: true });
    }
    /** Transition de statut sans changement de contenu (revision inchangée), gardée par statut + révision. */
    function transition(message, set, params, at) {
        const update = db.prepare(`UPDATE contact_messages SET ${set},updated_at=? WHERE id=? AND status=? AND revision=?`).run(...params, at, message.id, message.status, message.revision);
        if (update.changes !== 1)
            throw new ContactMessageError('revision_conflict', 'Le message a été modifié entre-temps : recharger avant de continuer');
        return getContactMessageById(db, message.id);
    }
    function missingForValidation(message) {
        const missing = [];
        if (!message.subject.trim())
            missing.push('subject');
        if (!message.body_text.trim())
            missing.push('body_text');
        if (!message.to_recipients.some(isEmail))
            missing.push('to');
        if (!message.from_email || !isEmail(message.from_email))
            missing.push('from_email');
        return missing;
    }
    return {
        /** Les trois étapes d'un prospect + valeurs par défaut de l'éditeur (From config, destinataire principal). */
        listMessages: (prospectId) => {
            const prospect = loadContext(prospectId);
            const existing = listContactMessages(db, prospectId);
            return {
                prospect, defaults: defaultsFor(prospectId),
                messages: contactMessageSteps.map(step => ({ step, message: existing.find(m => m.step === step) ?? null }))
            };
        },
        getMessage: (prospectId, step) => {
            loadContext(prospectId);
            const message = getContactMessage(db, prospectId, step);
            return { message, events: message ? listContactMessageEvents(db, message.id) : [] };
        },
        /**
         * Crée (sans `expected_revision`) ou édite (avec) le contenu d'une étape. Création : valeurs par défaut (From config,
         * email principal) complétées par la saisie, statut `draft`, séquence ouverte exigée. Édition : voir `editContent`.
         */
        saveMessage: (prospectId, step, input, actor) => {
            requireHuman(actor);
            return db.transaction(() => {
                const context = loadContext(prospectId);
                const at = now().toISOString();
                const existing = getContactMessage(db, prospectId, step);
                if (!existing) {
                    if (input.expected_revision)
                        throw new ContactMessageError('message_not_found', 'Message introuvable');
                    requireOpenSequence(context);
                    return create(prospectId, step, contentFrom(input, defaultContent(prospectId)), actor, at);
                }
                requireNotSent(existing);
                if (input.expected_revision === undefined || input.expected_revision === null)
                    throw new ContactMessageError('message_exists', 'Le message de cette étape existe déjà : recharger avant de continuer');
                requireRevision(existing, input.expected_revision);
                return editContent(existing, contentFrom(input, existing), actor, at);
            })();
        },
        /** Validation humaine explicite de la révision courante (décision 23). */
        validate: (prospectId, step, expectedRevision, actor) => {
            requireHuman(actor);
            return db.transaction(() => {
                const context = loadContext(prospectId);
                const message = requireMessage(prospectId, step);
                requireNotSent(message);
                requireRevision(message, expectedRevision);
                if (message.status !== 'draft')
                    throw invalidTransition(message.status, 'valider');
                requireOpenSequence(context);
                const missing = missingForValidation(message);
                if (missing.length)
                    throw new ContactMessageError('message_incomplete', `Message incomplet : ${missing.join(', ')}`, missing);
                const at = now().toISOString();
                const updated = transition(message, "status='validated',validated_at=?,validated_by_actor_id=?,validated_revision=revision", [at, actor.id], at);
                appendContactMessageEvent(db, { messageId: message.id, type: 'validated', actor, at, fromStatus: 'draft', toStatus: 'validated', revision: message.revision });
                writeAudit(actor, updated, 'message_validate', message);
                return result(updated);
            })();
        },
        /** Programmation : depuis `validated` seulement, date/heure ISO 8601 avec fuseau, strictement future ; aucune heure par défaut. */
        schedule: (prospectId, step, input, actor) => {
            requireHuman(actor);
            const scheduled = z.iso.datetime({ offset: true }).safeParse(input.scheduled_at);
            if (!scheduled.success)
                throw new ContactMessageError('invalid_scheduled_at', 'Date/heure d’envoi invalide (ISO 8601 avec fuseau attendu)');
            const scheduledAt = new Date(scheduled.data);
            if (Number.isNaN(scheduledAt.getTime()))
                throw new ContactMessageError('invalid_scheduled_at', 'Date/heure d’envoi invalide');
            return db.transaction(() => {
                const context = loadContext(prospectId);
                const message = requireMessage(prospectId, step);
                requireNotSent(message);
                requireRevision(message, input.expected_revision);
                if (message.status !== 'validated')
                    throw invalidTransition(message.status, 'programmer');
                requireOpenSequence(context);
                const current = now();
                if (scheduledAt.getTime() <= current.getTime())
                    throw new ContactMessageError('scheduled_at_not_future', 'La date/heure d’envoi doit être dans le futur');
                const at = current.toISOString();
                // Nouvelle programmation = nouveau cycle d'envoi : diagnostic de l'envoi précédent (échec, retard) effacé (Task 16).
                const updated = transition(message, "status='scheduled',scheduled_at=?,dispatch_attempts=0,last_error_code=NULL,last_error_at=NULL", [scheduledAt.toISOString()], at);
                appendContactMessageEvent(db, { messageId: message.id, type: 'scheduled', actor, at, fromStatus: 'validated', toStatus: 'scheduled', revision: message.revision, details: { scheduled_at: updated.scheduled_at } });
                writeAudit(actor, updated, 'message_schedule', message);
                return result(updated);
            })();
        },
        /** Déprogrammation : `scheduled` -> `validated` (validation conservée, date effacée) ; refusée pendant un envoi. */
        unschedule: (prospectId, step, expectedRevision, actor) => {
            requireHuman(actor);
            return db.transaction(() => {
                loadContext(prospectId);
                const message = requireMessage(prospectId, step);
                requireNotSent(message);
                requireRevision(message, expectedRevision);
                if (message.status !== 'scheduled')
                    throw invalidTransition(message.status, 'déprogrammer');
                requireNotClaimed(message);
                const at = now().toISOString();
                const updated = transition(message, "status='validated',scheduled_at=NULL", [], at);
                // Pas de type d'événement dédié dans le contrat Task 11 : `validated` depuis `scheduled` = déprogrammation.
                appendContactMessageEvent(db, { messageId: message.id, type: 'validated', actor, at, fromStatus: 'scheduled', toStatus: 'validated', revision: message.revision, details: { action: 'unscheduled' } });
                writeAudit(actor, updated, 'message_unschedule', message);
                return result(updated);
            })();
        },
        /** Annulation humaine d'une étape non envoyée ; brouillon distant mis en file de suppression. */
        cancel: (prospectId, step, expectedRevision, actor) => {
            requireHuman(actor);
            return db.transaction(() => {
                loadContext(prospectId);
                const message = requireMessage(prospectId, step);
                requireNotSent(message);
                requireRevision(message, expectedRevision);
                if (!isCancellableContactMessage(message.status))
                    throw invalidTransition(message.status, 'annuler');
                requireNotClaimed(message);
                const at = now().toISOString();
                const remoteDraftQueued = queueRemoteCleanup(message, 'cancelled', at);
                const updated = transition(message, "status='cancelled',cancelled_at=?,cancel_reason='manual',remote_draft_id=NULL", [at], at);
                appendContactMessageEvent(db, { messageId: message.id, type: 'cancelled', actor, at, fromStatus: message.status, toStatus: 'cancelled', revision: message.revision, details: { reason: 'manual', remote_draft_queued: remoteDraftQueued } });
                writeAudit(actor, updated, 'message_cancel', message);
                return result(updated, { remoteDraftQueued });
            })();
        },
        /** Réouverture explicite d'une étape `cancelled` en `draft` (contenu conservé, revision+1), séquence ouverte exigée. */
        reopen: (prospectId, step, expectedRevision, actor) => {
            requireHuman(actor);
            return db.transaction(() => {
                const context = loadContext(prospectId);
                const message = requireMessage(prospectId, step);
                requireNotSent(message);
                requireRevision(message, expectedRevision);
                if (message.status !== 'cancelled')
                    throw invalidTransition(message.status, 'rouvrir');
                requireOpenSequence(context);
                const at = now().toISOString();
                const update = db.prepare("UPDATE contact_messages SET status='draft',revision=revision+1,cancelled_at=NULL,cancel_reason=NULL,scheduled_at=NULL,validated_at=NULL,validated_by_actor_id=NULL,validated_revision=NULL,remote_provider=NULL,remote_draft_id=NULL,updated_at=? WHERE id=? AND status='cancelled' AND revision=?")
                    .run(at, message.id, message.revision);
                if (update.changes !== 1)
                    throw new ContactMessageError('revision_conflict', 'Le message a été modifié entre-temps : recharger avant de continuer');
                const updated = getContactMessageById(db, message.id);
                // Pas de type `reopened` dans le contrat Task 11 : re-création explicite de l'étape = `created` depuis `cancelled`.
                appendContactMessageEvent(db, { messageId: message.id, type: 'created', actor, at, fromStatus: 'cancelled', toStatus: 'draft', revision: updated.revision, details: { step, reopened: true, previous_cancel_reason: message.cancel_reason } });
                writeAudit(actor, updated, 'message_reopen', message);
                return result(updated);
            })();
        },
        /**
         * Task 14 : enregistre un sujet/corps générés. Crée l'étape si absente (valeurs par défaut), sinon applique la règle
         * d'édition (validated/scheduled -> draft) ; résultat toujours `draft`, `generation_model`/`generation_prompt_version`
         * renseignés, événement `generated`. Acteur humain ou `agent` ; jamais de validation, programmation ni transition prospect.
         * `replaceScheduled: false` (route `generate`) refuse de remplacer un message programmé (`invalid_transition`, à déprogrammer
         * d'abord), vérifié dans la même transaction que l'écriture.
         */
        saveGeneratedContent: (prospectId, step, input, actor, options = {}) => {
            if (!(isHuman(actor) || (actor.type === 'agent' && actor.id)))
                throw new ContactMessageError('human_actor_required', 'Génération demandée sans acteur identifié');
            const generation = { model: input.model.trim(), promptVersion: input.prompt_version.trim() };
            return db.transaction(() => {
                const context = loadContext(prospectId);
                requireOpenSequence(context);
                const at = now().toISOString();
                const existing = getContactMessage(db, prospectId, step);
                if (!existing)
                    return create(prospectId, step, { ...defaultContent(prospectId), subject: input.subject, body_text: input.body_text }, actor, at, generation);
                requireNotSent(existing);
                if (input.expected_revision === undefined || input.expected_revision === null)
                    throw new ContactMessageError('message_exists', 'Le message de cette étape existe déjà : recharger avant de continuer');
                requireRevision(existing, input.expected_revision);
                if (options.replaceScheduled === false && existing.status === 'scheduled')
                    throw invalidTransition(existing.status, 'régénérer');
                return editContent(existing, { ...existing, subject: input.subject, body_text: input.body_text }, actor, at, generation);
            })();
        },
        /**
         * Tasks 15/16 : crée le brouillon distant d'un message validé/programmé sans id distant (appel adapter hors transaction),
         * puis le rattache si le message est inchangé ; sinon l'id est mis en file de suppression (`replaced`). Un échec adapter
         * ne change pas le statut (le brouillon reste recréable avant l'envoi) et renvoie un code de diagnostic.
         */
        syncRemoteDraft: async (messageId, actor) => {
            if (remoteDrafts === noRemoteDrafts)
                return { status: 'disabled' };
            const message = getContactMessageById(db, messageId);
            if (!message || (message.status !== 'validated' && message.status !== 'scheduled'))
                return { status: 'not_applicable' };
            if (message.remote_draft_id)
                return { status: 'already_present' };
            let ref;
            try {
                ref = await remoteDrafts.createDraft(message);
            }
            catch (e) {
                const code = e instanceof Error && 'code' in e && typeof e.code === 'string' ? e.code : 'remote_draft_create_failed';
                return { status: 'failed', code };
            }
            if (!ref)
                return { status: 'disabled' };
            const remote = ref;
            return db.transaction(() => {
                const at = now().toISOString();
                const attach = db.prepare("UPDATE contact_messages SET remote_provider=?,remote_draft_id=?,updated_at=? WHERE id=? AND revision=? AND validated_revision=revision AND status IN ('validated','scheduled') AND remote_draft_id IS NULL")
                    .run(remote.provider, remote.draftId, at, message.id, message.revision);
                if (attach.changes !== 1) {
                    const stillThere = Boolean(getContactMessageById(db, message.id));
                    queueRemoteCleanup({ id: stillThere ? message.id : null, remote_provider: remote.provider, remote_draft_id: remote.draftId }, 'replaced', at);
                    return { status: 'stale', provider: remote.provider };
                }
                appendContactMessageEvent(db, { messageId: message.id, type: 'remote_draft_created', actor, at, fromStatus: message.status, toStatus: message.status, revision: message.revision, details: { provider: remote.provider } });
                return { status: 'created', provider: remote.provider };
            })();
        },
        /**
         * Dispatcher (Task 16) uniquement, aucune route : `scheduled` -> `sent` après confirmation réelle de l'envoi. Exige le
         * verrou de dispatch posé par ce dispatcher (`claimId`) et une validation encore courante. Un seul UPDATE pose toutes les
         * colonnes finales (le trigger rend ensuite la ligne immuable). `reconciled` : envoi déduit après une issue incertaine (le
         * brouillon distant a quitté la boîte), tracé par `last_error_code='send_reconciled_draft_absent'` (diagnostic, pas une erreur).
         */
        markSent: (messageId, input, actor) => db.transaction(() => {
            const message = getContactMessageById(db, messageId);
            if (!message)
                throw new ContactMessageError('message_not_found', 'Message introuvable');
            requireNotSent(message);
            if (message.status !== 'scheduled' || message.validated_revision !== message.revision)
                throw invalidTransition(message.status, 'marquer envoyé');
            if (message.dispatch_claim_id !== input.claimId)
                throw new ContactMessageError('dispatch_claim_mismatch', 'Verrou d’envoi absent ou différent');
            const at = now().toISOString();
            const updated = transition(message, "status='sent',sent_at=?,remote_message_id=?,last_error_code=?,last_error_at=?", [at, input.remoteMessageId, input.reconciled ? SENT_RECONCILED_CODE : null, input.reconciled ? at : null], at);
            appendContactMessageEvent(db, { messageId, type: 'sent', actor, at, fromStatus: 'scheduled', toStatus: 'sent', revision: message.revision, details: { claim_id: input.claimId, reconciled: Boolean(input.reconciled) } });
            writeAudit(actor, updated, 'message_sent', message);
            return updated;
        })()
    };
}
