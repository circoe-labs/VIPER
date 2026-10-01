// Contrat de workflow Contact (source de vérité unique : états prospect, labels UI, étapes, cadence, semaines ISO).
// Module pur : aucun helper ne modifie un état ; toute transition reste une décision humaine (décision 10).
import { z } from 'zod';
// --- États prospect (ordre = ordre d'affichage) ---
export const prospectStates = ['neutral', 'contacted', 'r1', 'r2', 'response_received', 'appointment_obtained', 'failure', 'ignored'];
export const prospectStateSchema = z.enum(prospectStates);
export const DEFAULT_PROSPECT_STATE = 'neutral';
/** Label du badge d'état ; `null` = aucun badge (état neutre, décision 4). */
export const prospectStateLabels = {
    neutral: null, contacted: 'Contacté', r1: 'R1', r2: 'R2',
    response_received: 'Réponse reçue', appointment_obtained: 'RDV pris', failure: 'Failure', ignored: 'Ignoré'
};
/** États ayant une prochaine échéance active par défaut (premier contact, R1, R2, revue). */
export const prospectStatesWithNextAction = ['neutral', 'contacted', 'r1', 'r2'];
/** États dont le choix humain annule les messages futurs non envoyés (décision 29). */
export const prospectStatesCancellingSequence = ['response_received', 'appointment_obtained', 'ignored'];
/** États terminaux et persistants (décision 7). */
export const terminalProspectStates = ['ignored'];
export const isProspectState = (value) => prospectStateSchema.safeParse(value).success;
export const prospectStateBadgeLabel = (state) => prospectStateLabels[state];
export const prospectStateOrder = (state) => prospectStates.indexOf(state);
export const compareProspectStates = (a, b) => prospectStateOrder(a) - prospectStateOrder(b);
export const hasDefaultNextAction = (state) => prospectStatesWithNextAction.includes(state);
export const cancelsFutureMessages = (state) => prospectStatesCancellingSequence.includes(state);
export const isTerminalProspectState = (state) => terminalProspectStates.includes(state);
// --- Statuts legacy (avant Task 03) : lecture seule (historique, compat écriture) ; jamais réécrits comme nouvel état ---
export const legacyTrackingStatuses = ['to_contact', 'contacted', 'follow_up_1', 'follow_up_2', 'response_received', 'appointment_obtained', 'quote_sent', 'quote_follow_up', 'won', 'not_interested'];
export const isLegacyTrackingStatus = (value) => legacyTrackingStatuses.includes(value);
/** Mapping direct (Task 03, docs/06 §2) ; `not_interested` dépend du blocage durable (voir `mapLegacyTrackingStatus`). */
const legacyMapping = {
    to_contact: 'neutral', contacted: 'contacted', follow_up_1: 'r1', follow_up_2: 'r2',
    response_received: 'response_received', appointment_obtained: 'appointment_obtained',
    // Post-RDV : hors périmètre Contact V1, convergence vers `appointment_obtained` (ancien statut tracé dans l'historique).
    quote_sent: 'appointment_obtained', quote_follow_up: 'appointment_obtained', won: 'appointment_obtained'
};
/** `not_interested` -> `ignored` si `contactability_status=do_not_contact` (blocage durable), sinon `failure`. */
export function mapLegacyTrackingStatus(status, doNotContact) {
    if (status === 'not_interested')
        return doNotContact ? 'ignored' : 'failure';
    return legacyMapping[status];
}
// --- Étapes message ---
export const contactMessageSteps = ['contact', 'r1', 'r2'];
export const contactMessageStepSchema = z.enum(contactMessageSteps);
export const contactMessageStepLabels = { contact: 'Contact', r1: 'R1', r2: 'R2' };
export const isContactMessageStep = (value) => contactMessageStepSchema.safeParse(value).success;
// --- Statuts message (distincts de l'état prospect ; docs/02 §4) ---
export const contactMessageStatuses = ['draft', 'validated', 'scheduled', 'sent', 'cancelled'];
export const contactMessageStatusSchema = z.enum(contactMessageStatuses);
export const DEFAULT_CONTACT_MESSAGE_STATUS = 'draft';
/** Labels UI (décisions 21-24). */
export const contactMessageStatusLabels = {
    draft: 'Brouillon', validated: 'Validé', scheduled: 'Programmé', sent: 'Envoyé', cancelled: 'Annulé'
};
/** Transitions du contrat (docs/02 §4) : `validated/scheduled -> draft` = édition ; `sent` immuable ; `cancelled` sans sortie. */
export const contactMessageTransitions = {
    draft: ['validated', 'cancelled'],
    validated: ['scheduled', 'draft', 'cancelled'],
    scheduled: ['sent', 'draft', 'cancelled'],
    sent: [],
    cancelled: []
};
/** Statuts portant une validation humaine courante (validation de la révision en cours). */
export const validatedContactMessageStatuses = ['validated', 'scheduled', 'sent'];
/** Statuts « futurs non envoyés » annulés par un choix humain `response_received`/`appointment_obtained`/`ignored` (décision 29). */
export const cancellableContactMessageStatuses = ['draft', 'validated', 'scheduled'];
export const isContactMessageStatus = (value) => contactMessageStatusSchema.safeParse(value).success;
export const canTransitionContactMessage = (from, to) => contactMessageTransitions[from].includes(to);
export const isCancellableContactMessage = (status) => cancellableContactMessageStatuses.includes(status);
/**
 * Séquence fermée pour un prospect : état qui annule les messages futurs (décision 29) ou blocage `do_not_contact`.
 * Aucun message ne peut alors être créé, rouvert, validé ni programmé (Task 12).
 */
export const isContactSequenceClosed = (state, doNotContact) => doNotContact || (isProspectState(state) && cancelsFutureMessages(state));
/**
 * Réouverture d'une étape `cancelled` (Task 12) : ce n'est pas une transition de la machine d'état (`cancelled` reste sans
 * sortie automatique) mais une re-création explicite, par un humain, du message durable de l'étape (UNIQUE prospect/étape),
 * en `draft`, seulement si la séquence n'est pas fermée.
 */
export const canReopenContactMessage = (status, state, doNotContact) => status === 'cancelled' && !isContactSequenceClosed(state, doNotContact);
/** Événements du journal par message (`contact_message_events`) ; jamais de sujet/corps/destinataire dans leurs détails. */
export const contactMessageEventTypes = [
    'created', 'generated', 'edited', 'validated', 'unvalidated_by_edit', 'scheduled', 'dispatch_claimed', 'sent', 'send_failed',
    'cancelled', 'remote_draft_created', 'remote_draft_invalidated'
];
const DAY_MS = 86400000;
const isoYearStart = (year) => {
    const jan4 = Date.UTC(year, 0, 4);
    return jan4 - ((new Date(jan4).getUTCDay() + 6) % 7) * DAY_MS;
};
export const isoWeeksInYear = (year) => (isoYearStart(year + 1) - isoYearStart(year)) / DAY_MS / 7 === 53 ? 53 : 52;
export const isValidIsoWeek = (value) => {
    if (!value || typeof value !== 'object')
        return false;
    const { year, week } = value;
    return Number.isInteger(year) && Number.isInteger(week) && year >= 1970 && year <= 9999
        && week >= 1 && week <= isoWeeksInYear(year);
};
export const isoWeekSchema = z.object({ year: z.number().int(), week: z.number().int() }).refine(isValidIsoWeek, { message: 'Semaine ISO invalide' });
export const isoWeekMonday = ({ year, week }) => new Date(isoYearStart(year) + (week - 1) * 7 * DAY_MS);
export const isoWeekOf = (date) => {
    const day = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
    const thursday = day + (3 - ((new Date(day).getUTCDay() + 6) % 7)) * DAY_MS;
    const year = new Date(thursday).getUTCFullYear();
    return { year, week: Math.floor((thursday - isoYearStart(year)) / DAY_MS / 7) + 1 };
};
export const addIsoWeeks = (from, weeks) => isoWeekOf(new Date(isoWeekMonday(from).getTime() + weeks * 7 * DAY_MS));
export const compareIsoWeeks = (a, b) => a.year - b.year || a.week - b.week;
/** Badge UI court (`S40`) ; les filtres backend doivent utiliser le couple (year, week). */
export const formatIsoWeekBadge = ({ week }) => `S${week}`;
// --- Cadence par défaut (décisions 11-13) ---
/** Délai en semaines entre l'envoi d'une étape et la prochaine échéance : Contact→R1 +2, R1→R2 +2, R2→revue +4. */
export const defaultCadenceWeeks = { contact: 2, r1: 2, r2: 4 };
/** Étape déjà effectuée correspondant à un état de séquence. */
export const completedStepByState = { contacted: 'contact', r1: 'r1', r2: 'r2' };
/** Proposition pure de prochaine semaine après une étape ; ne change aucun état. */
export const suggestNextActionWeekAfterStep = (step, from) => addIsoWeeks(from, defaultCadenceWeeks[step]);
/** Proposition pure de prochaine semaine pour un état de séquence (`contacted`/`r1`/`r2`) ; `null` sinon. */
export const suggestNextActionWeek = (state, from) => {
    const step = completedStepByState[state];
    return step ? suggestNextActionWeekAfterStep(step, from) : null;
};
