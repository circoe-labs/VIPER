// Contrat de workflow Contact (source de vérité unique : états prospect, labels UI, étapes, cadence, semaines ISO).
// Module pur : aucun helper ne modifie un état ; toute transition reste une décision humaine (décision 10).
import { z } from 'zod';

// --- États prospect (ordre = ordre d'affichage) ---
export const prospectStates = ['neutral', 'contacted', 'r1', 'r2', 'response_received', 'appointment_obtained', 'failure', 'ignored'] as const;
export type ProspectState = typeof prospectStates[number];
export const prospectStateSchema = z.enum(prospectStates);
export const DEFAULT_PROSPECT_STATE: ProspectState = 'neutral';

/** Label du badge d'état ; `null` = aucun badge (état neutre, décision 4). */
export const prospectStateLabels: Readonly<Record<ProspectState, string | null>> = {
  neutral: null, contacted: 'Contacté', r1: 'R1', r2: 'R2',
  response_received: 'Réponse reçue', appointment_obtained: 'RDV pris', failure: 'Failure', ignored: 'Ignoré'
};

/** États ayant une prochaine échéance active par défaut (premier contact, R1, R2, revue). */
export const prospectStatesWithNextAction: readonly ProspectState[] = ['neutral', 'contacted', 'r1', 'r2'];
/** États dont le choix humain annule les messages futurs non envoyés (décision 29). */
export const prospectStatesCancellingSequence: readonly ProspectState[] = ['response_received', 'appointment_obtained', 'ignored'];
/** États terminaux et persistants (décision 7). */
export const terminalProspectStates: readonly ProspectState[] = ['ignored'];

export const isProspectState = (value: unknown): value is ProspectState => prospectStateSchema.safeParse(value).success;
export const prospectStateBadgeLabel = (state: ProspectState): string | null => prospectStateLabels[state];
export const prospectStateOrder = (state: ProspectState): number => prospectStates.indexOf(state);
export const compareProspectStates = (a: ProspectState, b: ProspectState): number => prospectStateOrder(a) - prospectStateOrder(b);
export const hasDefaultNextAction = (state: ProspectState): boolean => prospectStatesWithNextAction.includes(state);
export const cancelsFutureMessages = (state: ProspectState): boolean => prospectStatesCancellingSequence.includes(state);
export const isTerminalProspectState = (state: ProspectState): boolean => terminalProspectStates.includes(state);

// --- Statuts legacy (avant Task 03) : lecture seule (historique, compat écriture) ; jamais réécrits comme nouvel état ---
export const legacyTrackingStatuses = ['to_contact', 'contacted', 'follow_up_1', 'follow_up_2', 'response_received', 'appointment_obtained', 'quote_sent', 'quote_follow_up', 'won', 'not_interested'] as const;
export type LegacyTrackingStatus = typeof legacyTrackingStatuses[number];
export const isLegacyTrackingStatus = (value: unknown): value is LegacyTrackingStatus => legacyTrackingStatuses.includes(value as LegacyTrackingStatus);

/** Mapping direct (Task 03, docs/06 §2) ; `not_interested` dépend du blocage durable (voir `mapLegacyTrackingStatus`). */
const legacyMapping: Readonly<Record<Exclude<LegacyTrackingStatus, 'not_interested'>, ProspectState>> = {
  to_contact: 'neutral', contacted: 'contacted', follow_up_1: 'r1', follow_up_2: 'r2',
  response_received: 'response_received', appointment_obtained: 'appointment_obtained',
  // Post-RDV : hors périmètre Contact V1, convergence vers `appointment_obtained` (ancien statut tracé dans l'historique).
  quote_sent: 'appointment_obtained', quote_follow_up: 'appointment_obtained', won: 'appointment_obtained'
};

/** `not_interested` -> `ignored` si `contactability_status=do_not_contact` (blocage durable), sinon `failure`. */
export function mapLegacyTrackingStatus(status: LegacyTrackingStatus, doNotContact: boolean): ProspectState {
  if (status === 'not_interested') return doNotContact ? 'ignored' : 'failure';
  return legacyMapping[status];
}

// --- Étapes message ---
export const contactMessageSteps = ['contact', 'r1', 'r2'] as const;
export type ContactMessageStep = typeof contactMessageSteps[number];
export const contactMessageStepSchema = z.enum(contactMessageSteps);
export const contactMessageStepLabels: Readonly<Record<ContactMessageStep, string>> = { contact: 'Contact', r1: 'R1', r2: 'R2' };
export const isContactMessageStep = (value: unknown): value is ContactMessageStep => contactMessageStepSchema.safeParse(value).success;

// --- Semaines ISO (année ISO + semaine ISO, calculs en UTC) ---
export type IsoWeek = { year: number; week: number };
const DAY_MS = 86400000;
const isoYearStart = (year: number): number => { // lundi de la semaine 1 (celle qui contient le 4 janvier)
  const jan4 = Date.UTC(year, 0, 4);
  return jan4 - ((new Date(jan4).getUTCDay() + 6) % 7) * DAY_MS;
};
export const isoWeeksInYear = (year: number): 52 | 53 => (isoYearStart(year + 1) - isoYearStart(year)) / DAY_MS / 7 === 53 ? 53 : 52;
export const isValidIsoWeek = (value: unknown): value is IsoWeek => {
  if (!value || typeof value !== 'object') return false;
  const { year, week } = value as Record<string, unknown>;
  return Number.isInteger(year) && Number.isInteger(week) && (year as number) >= 1970 && (year as number) <= 9999
    && (week as number) >= 1 && (week as number) <= isoWeeksInYear(year as number);
};
export const isoWeekSchema = z.object({ year: z.number().int(), week: z.number().int() }).refine(isValidIsoWeek, { message: 'Semaine ISO invalide' });
export const isoWeekMonday = ({ year, week }: IsoWeek): Date => new Date(isoYearStart(year) + (week - 1) * 7 * DAY_MS);
export const isoWeekOf = (date: Date): IsoWeek => {
  const day = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
  const thursday = day + (3 - ((new Date(day).getUTCDay() + 6) % 7)) * DAY_MS;
  const year = new Date(thursday).getUTCFullYear();
  return { year, week: Math.floor((thursday - isoYearStart(year)) / DAY_MS / 7) + 1 };
};
export const addIsoWeeks = (from: IsoWeek, weeks: number): IsoWeek => isoWeekOf(new Date(isoWeekMonday(from).getTime() + weeks * 7 * DAY_MS));
export const compareIsoWeeks = (a: IsoWeek, b: IsoWeek): number => a.year - b.year || a.week - b.week;
/** Badge UI court (`S40`) ; les filtres backend doivent utiliser le couple (year, week). */
export const formatIsoWeekBadge = ({ week }: IsoWeek): string => `S${week}`;

// --- Cadence par défaut (décisions 11-13) ---
/** Délai en semaines entre l'envoi d'une étape et la prochaine échéance : Contact→R1 +2, R1→R2 +2, R2→revue +4. */
export const defaultCadenceWeeks: Readonly<Record<ContactMessageStep, number>> = { contact: 2, r1: 2, r2: 4 };
/** Étape déjà effectuée correspondant à un état de séquence. */
export const completedStepByState: Readonly<Partial<Record<ProspectState, ContactMessageStep>>> = { contacted: 'contact', r1: 'r1', r2: 'r2' };

/** Proposition pure de prochaine semaine après une étape ; ne change aucun état. */
export const suggestNextActionWeekAfterStep = (step: ContactMessageStep, from: IsoWeek): IsoWeek => addIsoWeeks(from, defaultCadenceWeeks[step]);
/** Proposition pure de prochaine semaine pour un état de séquence (`contacted`/`r1`/`r2`) ; `null` sinon. */
export const suggestNextActionWeek = (state: ProspectState, from: IsoWeek): IsoWeek | null => {
  const step = completedStepByState[state];
  return step ? suggestNextActionWeekAfterStep(step, from) : null;
};
