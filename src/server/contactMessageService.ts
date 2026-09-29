// Machine d'état des messages Contact/R1/R2 (Task 12) : seule porte d'écriture applicative de `contact_messages` hors
// annulation mécanique (décision 29, `cancelFutureContactMessages`) ; `index.ts` ne fait que déléguer.
//
// Statuts (docs/02 §4, `contactWorkflow.ts`) :
//   draft -> validated        validation humaine explicite de la révision courante (`validate`)
//   validated -> scheduled    date/heure future obligatoire, aucune heure par défaut (`schedule`)
//   scheduled -> validated    déprogrammation, la validation reste courante (`unschedule`)
//   validated|scheduled -> draft  toute édition du contenu (`saveMessage`, `saveGeneratedContent`) : revision+1, validation
//                             effacée, date effacée, brouillon distant mis en file de suppression, événement `unvalidated_by_edit`
//   scheduled -> sent         réservé au dispatcher (`markSent`, méthode interne, aucune route HTTP)
//   draft|validated|scheduled -> cancelled  action humaine (`cancel`) ou changement d'état prospect (hook du suivi)
//   sent                      immuable (service + trigger SQL)
//   cancelled -> draft        PAS une transition : réouverture explicite par un humain (`reopen`), seulement si la séquence
//                             n'est pas fermée (`isContactSequenceClosed` : response_received / appointment_obtained / ignored /
//                             do_not_contact) ; le message rouvert garde son contenu, revision+1, doit être revalidé.
//
// Règles transverses :
// - verrou optimiste : toute mutation d'un message existant exige `expected_revision` = `revision` courante (sinon 409) ;
//   `revision` ne change qu'avec le contenu (validation/programmation ne l'incrémentent pas) ;
// - acteur humain authentifié obligatoire pour éditer, valider, programmer, déprogrammer, annuler, rouvrir ; la génération
//   (Task 14) accepte un acteur `agent` car elle ne produit qu'un `draft` ;
// - séquence fermée : création, réouverture, génération, validation et programmation refusées ;
// - From par défaut = `DEFAULT_OUTBOUND_EMAIL` (injecté, jamais codé en dur) ; destinataire par défaut = email principal actif ;
// - journal `contact_message_events` + `audit_log` sans contenu (ni sujet, ni corps, ni adresse) : codes, statuts, révisions.
//
// Points d'extension :
// - Task 14 : `saveGeneratedContent` (contenu IA => toujours `draft`, `generation_model`/`generation_prompt_version`, `generated`) ;
// - Tasks 15/16 : `RemoteDraftPort.createDraft` appelé après validation/programmation par `syncRemoteDraft` (no-op par défaut),
//   suppression des brouillons obsolètes via la file `contact_message_remote_draft_cleanups` (traitée après commit, Task 16),
//   `markSent` pour le dispatcher (verrou `dispatch_claim_id` posé par la Task 16).
import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Actor } from './audit.js';
import {
  appendContactMessageEvent, createContactMessage, getContactMessage, getContactMessageById, listContactMessageEvents, listContactMessages,
  type ContactMessageEventRecord, type ContactMessageRecord
} from './contactMessageStore.js';
import type { RemoteDraftCleanupReason } from './contactMessageSchema.js';
import {
  contactMessageSteps, contactMessageStepSchema, isCancellableContactMessage, isContactSequenceClosed,
  type ContactMessageStatus, type ContactMessageStep
} from '../shared/contactWorkflow.js';

type Db = Database.Database;

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
} as const;
export type ContactMessageErrorCode = keyof typeof contactMessageErrorStatus;
export class ContactMessageError extends Error {
  readonly code: ContactMessageErrorCode;
  readonly httpStatus: number;
  /** Champs manquants (`message_incomplete`) : noms de champs seulement. */
  readonly fields?: string[];
  constructor(code: ContactMessageErrorCode, message: string, fields?: string[]) {
    super(message);
    this.name = 'ContactMessageError';
    this.code = code;
    this.httpStatus = contactMessageErrorStatus[code];
    if (fields) this.fields = fields;
  }
}

/** Diagnostic d'un envoi déduit par réconciliation (issue incertaine, brouillon distant disparu) : voir `markSent`. */
export const SENT_RECONCILED_CODE = 'send_reconciled_draft_absent';

// --- Points d'extension brouillon distant (Tasks 15/16) ---
export type RemoteDraftRef = { provider: string; draftId: string };
/**
 * Adapter Toolbox (Task 15). `createDraft` reçoit un message validé/programmé (révision courante) et renvoie l'id distant,
 * ou `null` si l'intégration est inactive. Appelé hors transaction SQLite ; le résultat est rattaché seulement si le message
 * n'a pas changé entre-temps, sinon l'id est mis en file de suppression (`replaced`).
 */
export type RemoteDraftPort = { createDraft(message: ContactMessageRecord): Promise<RemoteDraftRef | null> };
export const noRemoteDrafts: RemoteDraftPort = { createDraft: async () => null };
export type RemoteDraftSync =
  | { status: 'disabled' | 'not_applicable' | 'already_present' }
  | { status: 'created'; provider: string }
  | { status: 'stale'; provider: string }
  | { status: 'failed'; code: string };

export type ContactMessageDeps = {
  now?: () => Date;
  /** `DEFAULT_OUTBOUND_EMAIL` (config serveur) ; ignorée si absente ou invalide. */
  defaultFromEmail?: string | null;
  remoteDrafts?: RemoteDraftPort;
};

// --- Types de lecture / résultat ---
export type ProspectMessageContext = { id: string; state: string | null; do_not_contact: boolean; sequence_closed: boolean };
export type MessageDefaults = { from_email: string | null; to: string[] };
export type ProspectMessages = {
  prospect: ProspectMessageContext;
  defaults: MessageDefaults;
  /** Toujours trois entrées, ordre Contact, R1, R2 ; `message: null` = étape jamais créée (brouillon vide côté UI). */
  messages: { step: ContactMessageStep; message: ContactMessageRecord | null }[];
};
export type MessageMutationResult = {
  message: ContactMessageRecord;
  created: boolean;
  /** Contenu ou statut modifié par cet appel (une sauvegarde identique ne change rien, ne dévalide rien). */
  changed: boolean;
  /** Validation perdue par une édition (validated/scheduled -> draft). */
  unvalidated: boolean;
  /** Brouillon distant mis en file de suppression. */
  remoteDraftQueued: boolean;
};

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
export type MessageContentInput = z.infer<typeof messageContentSchema>;
const revisionOnlySchema = z.object({ expected_revision: revision }).strict();
const scheduleSchema = z.object({ expected_revision: revision, scheduled_at: z.string() }).strict();
/** Contenu produit par l'IA (Task 14) : sujet/corps seulement, jamais de statut. */
export const generatedContentSchema = z.object({
  subject: z.string().max(998), body_text: z.string().max(100000),
  model: z.string().trim().min(1).max(200), prompt_version: z.string().trim().min(1).max(200),
  expected_revision: revision.nullable().optional()
}).strict();
export type GeneratedContentInput = z.infer<typeof generatedContentSchema>;

function parse<T>(schema: z.ZodType<T>, body: unknown): T {
  const parsed = schema.safeParse(body ?? {});
  if (parsed.success) return parsed.data;
  const field = String(parsed.error.issues[0]?.path[0] ?? '');
  if (field === 'expected_revision') throw new ContactMessageError('revision_required', 'Révision attendue manquante ou invalide');
  if (field === 'scheduled_at') throw new ContactMessageError('invalid_scheduled_at', 'Date/heure d’envoi invalide');
  throw new ContactMessageError('invalid_payload', 'Données du message invalides');
}
export const parseMessageStep = (value: unknown): ContactMessageStep => {
  const parsed = contactMessageStepSchema.safeParse(value);
  if (!parsed.success) throw new ContactMessageError('invalid_step', 'Étape de message invalide');
  return parsed.data;
};
export const parseMessageContent = (body: unknown) => parse(messageContentSchema, body);
export const parseExpectedRevision = (body: unknown) => parse(revisionOnlySchema, body).expected_revision;
export const parseSchedule = (body: unknown) => parse(scheduleSchema, body);
export const parseGeneratedContent = (body: unknown) => parse(generatedContentSchema, body);

const isEmail = (value: string) => emailSchema.safeParse(value).success;
const isHuman = (actor: Actor) => actor.type === 'human' && Boolean(actor.id);
/** Adresses nettoyées (trim, dédoublonnées sans casse) ; une adresse invalide est refusée, jamais ignorée en silence. */
function normalizeRecipients(values: string[]): string[] {
  const out: string[] = [];
  for (const raw of values) {
    const value = raw.trim();
    if (!value) continue;
    if (!isEmail(value)) throw new ContactMessageError('invalid_recipient', 'Adresse destinataire invalide');
    if (!out.some(v => v.toLowerCase() === value.toLowerCase())) out.push(value);
  }
  return out;
}
function normalizeFrom(value: string | null | undefined): string | null {
  const from = (value ?? '').trim();
  if (!from) return null;
  if (!isEmail(from)) throw new ContactMessageError('invalid_from_email', 'Adresse d’expéditeur invalide');
  return from;
}

type Content = { from_email: string | null; subject: string; body_text: string; to_recipients: string[]; cc_recipients: string[]; bcc_recipients: string[] };
const contentFields = ['from_email', 'subject', 'body_text', 'to_recipients', 'cc_recipients', 'bcc_recipients'] as const;
const sameValue = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

export function createContactMessageService(db: Db, deps: ContactMessageDeps = {}) {
  const now = deps.now ?? (() => new Date());
  const remoteDrafts = deps.remoteDrafts ?? noRemoteDrafts;
  const defaultFrom = deps.defaultFromEmail && isEmail(deps.defaultFromEmail.trim()) ? deps.defaultFromEmail.trim() : null;

  function loadContext(prospectId: string): ProspectMessageContext {
    const row = db.prepare('SELECT p.id,p.contactability_status,ct.status FROM prospects p LEFT JOIN contact_tracking ct ON ct.prospect_id=p.id WHERE p.id=?')
      .get(prospectId) as { id: string; contactability_status: string; status: string | null } | undefined;
    if (!row) throw new ContactMessageError('prospect_not_found', 'Prospect introuvable');
    const doNotContact = row.contactability_status === 'do_not_contact';
    return { id: row.id, state: row.status, do_not_contact: doNotContact, sequence_closed: isContactSequenceClosed(row.status, doNotContact) };
  }
  function defaultsFor(prospectId: string): MessageDefaults {
    const primary = db.prepare('SELECT address FROM emails WHERE prospect_id=? AND is_primary=1 AND is_active=1').get(prospectId) as { address: string } | undefined;
    return { from_email: defaultFrom, to: primary && isEmail(primary.address.trim()) ? [primary.address.trim()] : [] };
  }
  function requireOpenSequence(context: ProspectMessageContext) {
    if (context.do_not_contact) throw new ContactMessageError('prospect_do_not_contact', 'Prospect à ne plus contacter : aucun message possible');
    if (context.sequence_closed) throw new ContactMessageError('prospect_sequence_closed', 'Séquence fermée par l’état du prospect : aucun message possible');
  }
  const requireHuman = (actor: Actor) => {
    if (!isHuman(actor)) throw new ContactMessageError('human_actor_required', 'Action humaine authentifiée requise');
  };
  function requireMessage(prospectId: string, step: ContactMessageStep) {
    const message = getContactMessage(db, prospectId, step);
    if (!message) throw new ContactMessageError('message_not_found', 'Message introuvable');
    return message;
  }
  function requireRevision(message: ContactMessageRecord, expected: number | null | undefined) {
    if (expected === undefined || expected === null) throw new ContactMessageError('revision_required', 'Révision attendue manquante');
    if (expected !== message.revision) throw new ContactMessageError('revision_conflict', 'Le message a été modifié entre-temps : recharger avant de continuer');
  }
  const requireNotSent = (message: ContactMessageRecord) => {
    if (message.status === 'sent') throw new ContactMessageError('message_sent_immutable', 'Un message envoyé ne peut plus être modifié');
  };
  const requireNotClaimed = (message: ContactMessageRecord) => {
    if (message.dispatch_claim_id) throw new ContactMessageError('dispatch_in_progress', 'Envoi en cours : message verrouillé');
  };
  const invalidTransition = (from: ContactMessageStatus, action: string) =>
    new ContactMessageError('invalid_transition', `Action « ${action} » impossible depuis le statut ${from}`);

  function writeAudit(actor: Actor, message: ContactMessageRecord, action: string, before: Partial<ContactMessageRecord> | null, extra: Record<string, unknown> = {}) {
    const snapshot = (m: Partial<ContactMessageRecord> | null) => m ? { step: m.step, status: m.status, revision: m.revision, scheduled_at: m.scheduled_at ?? null } : null;
    db.prepare('INSERT INTO audit_log(id,actor_type,actor_id,actor_display,entity_type,entity_id,action,changed_fields,before_payload,after_payload,source_context) VALUES(?,?,?,?,?,?,?,?,?,?,?)')
      .run(randomUUID(), actor.type, actor.id ?? null, actor.display ?? null, 'contact_message', message.id, action, JSON.stringify([]),
        JSON.stringify(snapshot(before)), JSON.stringify({ ...snapshot(message), prospect_id: message.prospect_id, ...extra }), 'contact');
  }
  function queueRemoteCleanup(message: { id: string | null; remote_provider: string | null; remote_draft_id: string | null }, reason: RemoteDraftCleanupReason, at: string) {
    if (!message.remote_draft_id || !message.remote_provider) return false;
    db.prepare('INSERT OR IGNORE INTO contact_message_remote_draft_cleanups(id,message_id,remote_provider,remote_draft_id,reason,created_at) VALUES(?,?,?,?,?,?)')
      .run(randomUUID(), message.id, message.remote_provider, message.remote_draft_id, reason, at);
    return true;
  }

  const result = (message: ContactMessageRecord, flags: Partial<Omit<MessageMutationResult, 'message'>> = {}): MessageMutationResult =>
    ({ message, created: false, changed: true, unvalidated: false, remoteDraftQueued: false, ...flags });

  // Édition du contenu d'un message existant (manuelle ou générée) : cœur unique de la règle « édition => revalidation ».
  function editContent(existing: ContactMessageRecord, next: Content, actor: Actor, at: string, generation?: { model: string; promptVersion: string }): MessageMutationResult {
    requireNotSent(existing);
    if (existing.status === 'cancelled') throw new ContactMessageError('message_cancelled', 'Message annulé : le rouvrir avant de le modifier');
    const changedFields = contentFields.filter(key => !sameValue(existing[key], next[key]));
    if (!changedFields.length && !generation) return result(existing, { changed: false });
    requireNotClaimed(existing);
    const wasValidated = existing.status === 'validated' || existing.status === 'scheduled';
    const revisionNext = existing.revision + 1;
    const remoteDraftQueued = wasValidated && queueRemoteCleanup(existing, 'edited', at);
    const update = db.prepare(`UPDATE contact_messages SET status='draft',from_email=?,subject=?,body_text=?,to_recipients_json=?,cc_recipients_json=?,bcc_recipients_json=?,
      revision=?,scheduled_at=NULL,validated_at=NULL,validated_by_actor_id=NULL,validated_revision=NULL,remote_provider=NULL,remote_draft_id=NULL,
      generation_model=?,generation_prompt_version=?,updated_at=? WHERE id=? AND revision=?`)
      .run(next.from_email, next.subject, next.body_text, JSON.stringify(next.to_recipients), JSON.stringify(next.cc_recipients), JSON.stringify(next.bcc_recipients),
        revisionNext, generation?.model ?? existing.generation_model, generation?.promptVersion ?? existing.generation_prompt_version, at, existing.id, existing.revision);
    if (update.changes !== 1) throw new ContactMessageError('revision_conflict', 'Le message a été modifié entre-temps : recharger avant de continuer');
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
    const message = getContactMessageById(db, existing.id) as ContactMessageRecord;
    writeAudit(actor, message, generation ? 'message_generate' : 'message_edit', existing, { unvalidated: wasValidated });
    return result(message, { unvalidated: wasValidated, remoteDraftQueued });
  }

  function contentFrom(input: MessageContentInput, base: Content): Content {
    return {
      from_email: input.from_email !== undefined ? normalizeFrom(input.from_email) : base.from_email,
      subject: input.subject ?? base.subject,
      body_text: input.body_text ?? base.body_text,
      to_recipients: input.to ? normalizeRecipients(input.to) : base.to_recipients,
      cc_recipients: input.cc ? normalizeRecipients(input.cc) : base.cc_recipients,
      bcc_recipients: input.bcc ? normalizeRecipients(input.bcc) : base.bcc_recipients
    };
  }
  const defaultContent = (prospectId: string): Content => {
    const defaults = defaultsFor(prospectId);
    return { from_email: defaults.from_email, subject: '', body_text: '', to_recipients: defaults.to, cc_recipients: [], bcc_recipients: [] };
  };
  function create(prospectId: string, step: ContactMessageStep, content: Content, actor: Actor, at: string, generation?: { model: string; promptVersion: string }) {
    const message = createContactMessage(db, {
      prospectId, step, actor, at, fromEmail: content.from_email, subject: content.subject, bodyText: content.body_text,
      to: content.to_recipients, cc: content.cc_recipients, bcc: content.bcc_recipients, ...(generation ? { generation } : {})
    });
    writeAudit(actor, message, generation ? 'message_generate' : 'message_create', null);
    return result(message, { created: true });
  }

  /** Transition de statut sans changement de contenu (revision inchangée), gardée par statut + révision. */
  function transition(message: ContactMessageRecord, set: string, params: unknown[], at: string) {
    const update = db.prepare(`UPDATE contact_messages SET ${set},updated_at=? WHERE id=? AND status=? AND revision=?`).run(...params, at, message.id, message.status, message.revision);
    if (update.changes !== 1) throw new ContactMessageError('revision_conflict', 'Le message a été modifié entre-temps : recharger avant de continuer');
    return getContactMessageById(db, message.id) as ContactMessageRecord;
  }

  function missingForValidation(message: ContactMessageRecord): string[] {
    const missing: string[] = [];
    if (!message.subject.trim()) missing.push('subject');
    if (!message.body_text.trim()) missing.push('body_text');
    if (!message.to_recipients.some(isEmail)) missing.push('to');
    if (!message.from_email || !isEmail(message.from_email)) missing.push('from_email');
    return missing;
  }

  return {
    /** Les trois étapes d'un prospect + valeurs par défaut de l'éditeur (From config, destinataire principal). */
    listMessages: (prospectId: string): ProspectMessages => {
      const prospect = loadContext(prospectId);
      const existing = listContactMessages(db, prospectId);
      return {
        prospect, defaults: defaultsFor(prospectId),
        messages: contactMessageSteps.map(step => ({ step, message: existing.find(m => m.step === step) ?? null }))
      };
    },
    getMessage: (prospectId: string, step: ContactMessageStep): { message: ContactMessageRecord | null; events: ContactMessageEventRecord[] } => {
      loadContext(prospectId);
      const message = getContactMessage(db, prospectId, step);
      return { message, events: message ? listContactMessageEvents(db, message.id) : [] };
    },

    /**
     * Crée (sans `expected_revision`) ou édite (avec) le contenu d'une étape. Création : valeurs par défaut (From config,
     * email principal) complétées par la saisie, statut `draft`, séquence ouverte exigée. Édition : voir `editContent`.
     */
    saveMessage: (prospectId: string, step: ContactMessageStep, input: MessageContentInput, actor: Actor): MessageMutationResult => {
      requireHuman(actor);
      return db.transaction((): MessageMutationResult => {
        const context = loadContext(prospectId);
        const at = now().toISOString();
        const existing = getContactMessage(db, prospectId, step);
        if (!existing) {
          if (input.expected_revision) throw new ContactMessageError('message_not_found', 'Message introuvable');
          requireOpenSequence(context);
          return create(prospectId, step, contentFrom(input, defaultContent(prospectId)), actor, at);
        }
        requireNotSent(existing);
        if (input.expected_revision === undefined || input.expected_revision === null) throw new ContactMessageError('message_exists', 'Le message de cette étape existe déjà : recharger avant de continuer');
        requireRevision(existing, input.expected_revision);
        return editContent(existing, contentFrom(input, existing), actor, at);
      })();
    },

    /** Validation humaine explicite de la révision courante (décision 23). */
    validate: (prospectId: string, step: ContactMessageStep, expectedRevision: number, actor: Actor): MessageMutationResult => {
      requireHuman(actor);
      return db.transaction((): MessageMutationResult => {
        const context = loadContext(prospectId);
        const message = requireMessage(prospectId, step);
        requireNotSent(message);
        requireRevision(message, expectedRevision);
        if (message.status !== 'draft') throw invalidTransition(message.status, 'valider');
        requireOpenSequence(context);
        const missing = missingForValidation(message);
        if (missing.length) throw new ContactMessageError('message_incomplete', `Message incomplet : ${missing.join(', ')}`, missing);
        const at = now().toISOString();
        const updated = transition(message, "status='validated',validated_at=?,validated_by_actor_id=?,validated_revision=revision", [at, actor.id], at);
        appendContactMessageEvent(db, { messageId: message.id, type: 'validated', actor, at, fromStatus: 'draft', toStatus: 'validated', revision: message.revision });
        writeAudit(actor, updated, 'message_validate', message);
        return result(updated);
      })();
    },

    /** Programmation : depuis `validated` seulement, date/heure ISO 8601 avec fuseau, strictement future ; aucune heure par défaut. */
    schedule: (prospectId: string, step: ContactMessageStep, input: { expected_revision: number; scheduled_at: string }, actor: Actor): MessageMutationResult => {
      requireHuman(actor);
      const scheduled = z.iso.datetime({ offset: true }).safeParse(input.scheduled_at);
      if (!scheduled.success) throw new ContactMessageError('invalid_scheduled_at', 'Date/heure d’envoi invalide (ISO 8601 avec fuseau attendu)');
      const scheduledAt = new Date(scheduled.data);
      if (Number.isNaN(scheduledAt.getTime())) throw new ContactMessageError('invalid_scheduled_at', 'Date/heure d’envoi invalide');
      return db.transaction((): MessageMutationResult => {
        const context = loadContext(prospectId);
        const message = requireMessage(prospectId, step);
        requireNotSent(message);
        requireRevision(message, input.expected_revision);
        if (message.status !== 'validated') throw invalidTransition(message.status, 'programmer');
        requireOpenSequence(context);
        const current = now();
        if (scheduledAt.getTime() <= current.getTime()) throw new ContactMessageError('scheduled_at_not_future', 'La date/heure d’envoi doit être dans le futur');
        const at = current.toISOString();
        // Nouvelle programmation = nouveau cycle d'envoi : diagnostic de l'envoi précédent (échec, retard) effacé (Task 16).
        const updated = transition(message, "status='scheduled',scheduled_at=?,dispatch_attempts=0,last_error_code=NULL,last_error_at=NULL", [scheduledAt.toISOString()], at);
        appendContactMessageEvent(db, { messageId: message.id, type: 'scheduled', actor, at, fromStatus: 'validated', toStatus: 'scheduled', revision: message.revision, details: { scheduled_at: updated.scheduled_at } });
        writeAudit(actor, updated, 'message_schedule', message);
        return result(updated);
      })();
    },

    /** Déprogrammation : `scheduled` -> `validated` (validation conservée, date effacée) ; refusée pendant un envoi. */
    unschedule: (prospectId: string, step: ContactMessageStep, expectedRevision: number, actor: Actor): MessageMutationResult => {
      requireHuman(actor);
      return db.transaction((): MessageMutationResult => {
        loadContext(prospectId);
        const message = requireMessage(prospectId, step);
        requireNotSent(message);
        requireRevision(message, expectedRevision);
        if (message.status !== 'scheduled') throw invalidTransition(message.status, 'déprogrammer');
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
    cancel: (prospectId: string, step: ContactMessageStep, expectedRevision: number, actor: Actor): MessageMutationResult => {
      requireHuman(actor);
      return db.transaction((): MessageMutationResult => {
        loadContext(prospectId);
        const message = requireMessage(prospectId, step);
        requireNotSent(message);
        requireRevision(message, expectedRevision);
        if (!isCancellableContactMessage(message.status)) throw invalidTransition(message.status, 'annuler');
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
    reopen: (prospectId: string, step: ContactMessageStep, expectedRevision: number, actor: Actor): MessageMutationResult => {
      requireHuman(actor);
      return db.transaction((): MessageMutationResult => {
        const context = loadContext(prospectId);
        const message = requireMessage(prospectId, step);
        requireNotSent(message);
        requireRevision(message, expectedRevision);
        if (message.status !== 'cancelled') throw invalidTransition(message.status, 'rouvrir');
        requireOpenSequence(context);
        const at = now().toISOString();
        const update = db.prepare("UPDATE contact_messages SET status='draft',revision=revision+1,cancelled_at=NULL,cancel_reason=NULL,scheduled_at=NULL,validated_at=NULL,validated_by_actor_id=NULL,validated_revision=NULL,remote_provider=NULL,remote_draft_id=NULL,updated_at=? WHERE id=? AND status='cancelled' AND revision=?")
          .run(at, message.id, message.revision);
        if (update.changes !== 1) throw new ContactMessageError('revision_conflict', 'Le message a été modifié entre-temps : recharger avant de continuer');
        const updated = getContactMessageById(db, message.id) as ContactMessageRecord;
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
    saveGeneratedContent: (prospectId: string, step: ContactMessageStep, input: GeneratedContentInput, actor: Actor, options: { replaceScheduled?: boolean } = {}): MessageMutationResult => {
      if (!(isHuman(actor) || (actor.type === 'agent' && actor.id))) throw new ContactMessageError('human_actor_required', 'Génération demandée sans acteur identifié');
      const generation = { model: input.model.trim(), promptVersion: input.prompt_version.trim() };
      return db.transaction((): MessageMutationResult => {
        const context = loadContext(prospectId);
        requireOpenSequence(context);
        const at = now().toISOString();
        const existing = getContactMessage(db, prospectId, step);
        if (!existing) return create(prospectId, step, { ...defaultContent(prospectId), subject: input.subject, body_text: input.body_text }, actor, at, generation);
        requireNotSent(existing);
        if (input.expected_revision === undefined || input.expected_revision === null) throw new ContactMessageError('message_exists', 'Le message de cette étape existe déjà : recharger avant de continuer');
        requireRevision(existing, input.expected_revision);
        if (options.replaceScheduled === false && existing.status === 'scheduled') throw invalidTransition(existing.status, 'régénérer');
        return editContent(existing, { ...existing, subject: input.subject, body_text: input.body_text }, actor, at, generation);
      })();
    },

    /**
     * Tasks 15/16 : crée le brouillon distant d'un message validé/programmé sans id distant (appel adapter hors transaction),
     * puis le rattache si le message est inchangé ; sinon l'id est mis en file de suppression (`replaced`). Un échec adapter
     * ne change pas le statut (le brouillon reste recréable avant l'envoi) et renvoie un code de diagnostic.
     */
    syncRemoteDraft: async (messageId: string, actor: Actor): Promise<RemoteDraftSync> => {
      if (remoteDrafts === noRemoteDrafts) return { status: 'disabled' };
      const message = getContactMessageById(db, messageId);
      if (!message || (message.status !== 'validated' && message.status !== 'scheduled')) return { status: 'not_applicable' };
      if (message.remote_draft_id) return { status: 'already_present' };
      let ref: RemoteDraftRef | null;
      try {
        ref = await remoteDrafts.createDraft(message);
      } catch (e) {
        const code = e instanceof Error && 'code' in e && typeof e.code === 'string' ? e.code : 'remote_draft_create_failed';
        return { status: 'failed', code };
      }
      if (!ref) return { status: 'disabled' };
      const remote = ref;
      return db.transaction((): RemoteDraftSync => {
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
    markSent: (messageId: string, input: { claimId: string; remoteMessageId: string | null; reconciled?: boolean }, actor: Actor): ContactMessageRecord => db.transaction(() => {
      const message = getContactMessageById(db, messageId);
      if (!message) throw new ContactMessageError('message_not_found', 'Message introuvable');
      requireNotSent(message);
      if (message.status !== 'scheduled' || message.validated_revision !== message.revision) throw invalidTransition(message.status, 'marquer envoyé');
      if (message.dispatch_claim_id !== input.claimId) throw new ContactMessageError('dispatch_claim_mismatch', 'Verrou d’envoi absent ou différent');
      const at = now().toISOString();
      const updated = transition(message, "status='sent',sent_at=?,remote_message_id=?,last_error_code=?,last_error_at=?",
        [at, input.remoteMessageId, input.reconciled ? SENT_RECONCILED_CODE : null, input.reconciled ? at : null], at);
      appendContactMessageEvent(db, { messageId, type: 'sent', actor, at, fromStatus: 'scheduled', toStatus: 'sent', revision: message.revision, details: { claim_id: input.claimId, reconciled: Boolean(input.reconciled) } });
      writeAudit(actor, updated, 'message_sent', message);
      return updated;
    })()
  };
}
export type ContactMessageService = ReturnType<typeof createContactMessageService>;
