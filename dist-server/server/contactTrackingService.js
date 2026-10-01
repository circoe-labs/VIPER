import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { cancelsFutureMessages, DEFAULT_PROSPECT_STATE, hasDefaultNextAction, isoWeekOf, isProspectState, isTerminalProspectState, prospectStateSchema, suggestNextActionWeek } from '../shared/contactWorkflow.js';
import { resolveIncomingNextAction, toNextActionWeek } from './contactTrackingSchema.js';
import { toProspectStateForWrite } from './contactTrackingReconciliation.js';
// --- Erreurs métier typées (code stable + statut HTTP) ---
export const contactTrackingErrorStatus = {
    prospect_not_found: 404,
    invalid_payload: 400,
    invalid_state: 400,
    invalid_next_action: 400,
    human_actor_required: 403,
    ignored_is_terminal: 409,
    ignored_has_no_next_action: 409
};
export class ContactTrackingError extends Error {
    code;
    httpStatus;
    constructor(code, message) {
        super(message);
        this.name = 'ContactTrackingError';
        this.code = code;
        this.httpStatus = contactTrackingErrorStatus[code];
    }
}
/** Défaut tant que `contact_messages` n'existe pas (Task 11) : rien à annuler. */
export const noFutureMessages = () => ({ cancelled: 0 });
/** Corps de `PATCH /api/prospects/:id/tracking` : codes du contrat uniquement (aucun statut legacy). */
const trackingPatchSchema = z.object({
    status: prospectStateSchema.optional(),
    next_action_year: z.number().int().nullable().optional(),
    next_action_week: z.number().int().nullable().optional()
}).strict();
const isBlank = (value) => value === undefined || value === null || value === '';
const weekOf = (row) => row && row.next_action_year !== null && row.next_action_week !== null ? { year: row.next_action_year, week: row.next_action_week } : null;
const sameWeek = (a, b) => (a === null || b === null) ? a === b : a.year === b.year && a.week === b.week;
const optionalText = (value) => isBlank(value) ? null : String(value);
const isHuman = (actor) => actor.type === 'human' && !isBlank(actor.id);
function parseNextAction(year, week) {
    try {
        return toNextActionWeek(year, week);
    }
    catch {
        throw new ContactTrackingError('invalid_next_action', 'Semaine de prochaine action invalide');
    }
}
function parseLooseState(value, doNotContact) {
    try {
        return toProspectStateForWrite(value, doNotContact);
    }
    catch {
        throw new ContactTrackingError('invalid_state', 'État de suivi invalide');
    }
}
function parseIncomingNextAction(incoming, current) {
    try {
        return resolveIncomingNextAction(incoming, current);
    }
    catch {
        throw new ContactTrackingError('invalid_next_action', 'Semaine de prochaine action invalide');
    }
}
/** Valide le corps du PATCH ; au moins `status` ou le couple `next_action_year/next_action_week` (null/null = effacer). */
export function parseTrackingPatch(body) {
    const parsed = trackingPatchSchema.safeParse(body ?? {});
    if (!parsed.success) {
        const stateIssue = parsed.error.issues.some(issue => issue.path[0] === 'status');
        throw new ContactTrackingError(stateIssue ? 'invalid_state' : 'invalid_payload', stateIssue ? 'État de suivi invalide' : 'Mise à jour du suivi invalide');
    }
    const { status, next_action_year: year, next_action_week: week } = parsed.data;
    const hasWeek = year !== undefined || week !== undefined;
    if (!status && !hasWeek)
        throw new ContactTrackingError('invalid_payload', 'Aucune modification de suivi demandée');
    return { ...(status ? { state: status } : {}), ...(hasWeek ? { nextAction: parseNextAction(year, week) } : {}) };
}
export function createContactTrackingService(db, deps = {}) {
    const now = deps.now ?? (() => new Date());
    const cancelFutureMessages = deps.cancelFutureMessages ?? noFutureMessages;
    const loadTracking = (prospectId) => db.prepare('SELECT id,prospect_id,status,next_action_year,next_action_week,planned_contact_at,referent_id,response_received_at,appointment_at,created_at,updated_at FROM contact_tracking WHERE prospect_id=?')
        .get(prospectId);
    const loadProspect = (prospectId) => db.prepare('SELECT id,contactability_status FROM prospects WHERE id=?').get(prospectId);
    const requireProspect = (prospectId) => {
        const prospect = loadProspect(prospectId);
        if (!prospect)
            throw new ContactTrackingError('prospect_not_found', 'Prospect introuvable');
        return prospect;
    };
    function writeAudit(actor, prospectId, action, changedFields, before, after, source) {
        db.prepare('INSERT INTO audit_log(id,actor_type,actor_id,actor_display,entity_type,entity_id,action,changed_fields,before_payload,after_payload,source_context) VALUES(?,?,?,?,?,?,?,?,?,?,?)')
            .run(randomUUID(), actor.type, actor.id ?? null, actor.display ?? null, 'prospect', prospectId, action, JSON.stringify(changedFields), JSON.stringify(before ?? null), JSON.stringify(after ?? null), source);
    }
    // `ignored` => blocage durable, jamais levé ici (décision 7).
    function reinforceDoNotContact(prospect, actor, source) {
        if (prospect.contactability_status === 'do_not_contact')
            return false;
        db.prepare("UPDATE prospects SET contactability_status='do_not_contact',do_not_contact_at=coalesce(do_not_contact_at,CURRENT_TIMESTAMP),updated_at=CURRENT_TIMESTAMP WHERE id=?").run(prospect.id);
        writeAudit(actor, prospect.id, 'reinforce_do_not_contact', ['contactability_status'], { contactability_status: prospect.contactability_status }, { contactability_status: 'do_not_contact' }, source);
        return true;
    }
    const auditPayload = (row) => row ? {
        status: row.status, next_action_year: row.next_action_year ?? null, next_action_week: row.next_action_week ?? null,
        planned_contact_at: row.planned_contact_at ?? null, referent_id: row.referent_id ?? null,
        appointment_at: row.appointment_at ?? null, response_received_at: row.response_received_at ?? null
    } : null;
    // Cœur unique de mutation, toujours dans une transaction (savepoint si appelé depuis une transaction englobante).
    function mutate(prospectId, mutation, context) {
        if (context.requireHuman && !isHuman(context.actor))
            throw new ContactTrackingError('human_actor_required', 'Action humaine authentifiée requise');
        return db.transaction(() => {
            const prospect = requireProspect(prospectId);
            const current = loadTracking(prospectId);
            const at = context.at ?? now().toISOString();
            const previousStatus = current?.status ?? null;
            const target = mutation.state ?? previousStatus ?? DEFAULT_PROSPECT_STATE;
            const stateChanged = target !== previousStatus;
            if (current && stateChanged && isProspectState(current.status) && isTerminalProspectState(current.status)) {
                throw new ContactTrackingError('ignored_is_terminal', 'Un prospect ignoré ne peut pas changer d’état');
            }
            const targetState = isProspectState(target) ? target : null; // valeur inattendue conservée telle quelle (Task 03)
            if (targetState && isTerminalProspectState(targetState) && mutation.nextAction) {
                throw new ContactTrackingError('ignored_has_no_next_action', 'Un prospect ignoré n’a pas de prochaine échéance');
            }
            const currentWeek = weekOf(current);
            let nextWeek = currentWeek;
            if (stateChanged && targetState && !hasDefaultNextAction(targetState))
                nextWeek = null; // pas d'échéance active par défaut
            if (mutation.nextAction !== undefined)
                nextWeek = mutation.nextAction;
            const fields = mutation.fields ?? {};
            const pick = (key) => fields[key] !== undefined ? fields[key] ?? null : current?.[key] ?? null;
            const next = {
                status: target,
                next_action_year: nextWeek?.year ?? null,
                next_action_week: nextWeek?.week ?? null,
                planned_contact_at: pick('planned_contact_at'),
                referent_id: pick('referent_id'),
                appointment_at: pick('appointment_at'),
                response_received_at: current?.response_received_at ?? (stateChanged && target === 'response_received' ? at : null)
            };
            const changed = [];
            if (stateChanged)
                changed.push('status');
            if (!sameWeek(currentWeek, nextWeek))
                changed.push('next_action');
            for (const key of ['planned_contact_at', 'referent_id', 'appointment_at', 'response_received_at'])
                if ((current?.[key] ?? null) !== next[key])
                    changed.push(key);
            let trackingId = current?.id;
            if (!current) {
                trackingId = randomUUID();
                db.prepare('INSERT INTO contact_tracking(id,prospect_id,status,next_action_year,next_action_week,planned_contact_at,referent_id,response_received_at,appointment_at) VALUES(?,?,?,?,?,?,?,?,?)')
                    .run(trackingId, prospectId, next.status, next.next_action_year, next.next_action_week, next.planned_contact_at, next.referent_id, next.response_received_at, next.appointment_at);
            }
            else if (changed.length) {
                db.prepare('UPDATE contact_tracking SET status=?,next_action_year=?,next_action_week=?,planned_contact_at=?,referent_id=?,response_received_at=?,appointment_at=?,updated_at=CURRENT_TIMESTAMP WHERE id=?')
                    .run(next.status, next.next_action_year, next.next_action_week, next.planned_contact_at, next.referent_id, next.response_received_at, next.appointment_at, current.id);
            }
            if (stateChanged) {
                db.prepare('INSERT INTO contact_tracking_status_history(id,contact_tracking_id,from_status,to_status,actor_type,actor_id) VALUES(?,?,?,?,?,?)')
                    .run(randomUUID(), trackingId, previousStatus, target, context.actor.type, context.actor.id ?? null);
            }
            const doNotContactReinforced = target === 'ignored' ? reinforceDoNotContact(prospect, context.actor, context.source) : false;
            const cancellation = stateChanged && targetState && cancelsFutureMessages(targetState)
                ? cancelFutureMessages({ db, prospectId, trackingId: trackingId, fromState: previousStatus, toState: targetState, actor: context.actor, at })
                : { cancelled: 0 };
            const cancelledMessages = cancellation.cancelled;
            const inFlightMessages = cancellation.inFlight ?? 0;
            if (context.audit && (changed.length || !current)) {
                writeAudit(context.actor, prospectId, current ? 'tracking_update' : 'tracking_create', changed, auditPayload(current), { ...auditPayload(next), cancelled_messages: cancelledMessages }, context.source);
            }
            return {
                tracking: loadTracking(prospectId),
                created: !current, previousStatus, stateChanged, changed, doNotContactReinforced, cancelledMessages, inFlightMessages,
                suggestedNextAction: stateChanged && targetState ? suggestNextActionWeek(targetState, isoWeekOf(now())) : null
            };
        })();
    }
    return {
        getTracking: (prospectId) => {
            requireProspect(prospectId);
            return loadTracking(prospectId) ?? null;
        },
        getHistory: (prospectId) => {
            requireProspect(prospectId);
            return db.prepare('SELECT h.id,h.contact_tracking_id,h.from_status,h.to_status,h.changed_at,h.actor_type,h.actor_id FROM contact_tracking_status_history h JOIN contact_tracking ct ON ct.id=h.contact_tracking_id WHERE ct.prospect_id=? ORDER BY h.changed_at DESC,h.rowid DESC')
                .all(prospectId);
        },
        /** Mutation humaine publique (Prospection et Contact) : état et/ou prochaine semaine, codes du contrat uniquement. */
        updateTracking: (prospectId, patch, actor) => mutate(prospectId, patch, { actor, requireHuman: true, source: 'manual', audit: true }),
        /** Choix humain d'un état ; la semaine n'est touchée que par l'effacement mécanique des états sans échéance. */
        changeState: (prospectId, state, actor) => mutate(prospectId, { state }, { actor, requireHuman: true, source: 'manual', audit: true }),
        /** Pose (`IsoWeek`) ou efface (`null`) la prochaine semaine ; ne change jamais l'état. */
        setNextActionWeek: (prospectId, nextAction, actor) => mutate(prospectId, { nextAction }, { actor, requireHuman: true, source: 'manual', audit: true }),
        /**
         * Compatibilité `POST/PUT /api/prospects` (client existant) : `tracking` écho de la fiche, codes legacy acceptés
         * (`toProspectStateForWrite`), alias `contact_year/contact_week`. Une semaine identique à l'actuelle est un écho, pas une saisie.
         */
        applyProspectPayload: (prospectId, incoming, actor) => {
            if (!incoming)
                return null;
            const prospect = requireProspect(prospectId);
            const current = loadTracking(prospectId);
            const sameAsCurrent = current && incoming.status === current.status; // valeur inattendue renvoyée telle quelle : pas de transition
            const state = isBlank(incoming.status) || sameAsCurrent
                ? (current ? undefined : DEFAULT_PROSPECT_STATE)
                : parseLooseState(incoming.status, prospect.contactability_status === 'do_not_contact');
            const currentWeek = weekOf(current);
            const incomingWeek = parseIncomingNextAction(incoming, currentWeek);
            const fields = {};
            for (const key of ['planned_contact_at', 'referent_id', 'appointment_at'])
                if (incoming[key] !== undefined)
                    fields[key] = optionalText(incoming[key]);
            return mutate(prospectId, { state, nextAction: sameWeek(incomingWeek, currentWeek) ? undefined : incomingWeek, fields }, { actor, requireHuman: true, source: 'manual', audit: true });
        },
        /**
         * Import Excel (acteur `import`, non humain) : crée le suivi, ou ne fait avancer qu'un suivi encore `neutral` (règle Task 03).
         * Ne réécrit jamais un état choisi ; n'écrit aucune semaine sur un `ignored` ; `do_not_contact` jamais levé.
         */
        applyImport: (prospectId, imported, actor) => {
            const prospect = requireProspect(prospectId);
            const current = loadTracking(prospectId);
            const importedState = parseLooseState(imported.status, prospect.contactability_status === 'do_not_contact');
            const state = !current || (current.status === 'neutral' && importedState !== 'neutral') ? importedState : undefined;
            const resultingState = state ?? current?.status;
            const importedWeek = parseNextAction(imported.contactYear, imported.contactWeek);
            const fields = {};
            if (imported.plannedContactAt)
                fields.planned_contact_at = imported.plannedContactAt;
            if (imported.referentId)
                fields.referent_id = imported.referentId;
            return mutate(prospectId, {
                state,
                nextAction: importedWeek && resultingState !== 'ignored' ? importedWeek : undefined,
                fields
            }, { actor, requireHuman: false, source: 'import', audit: false, at: imported.importedAt });
        }
    };
}
