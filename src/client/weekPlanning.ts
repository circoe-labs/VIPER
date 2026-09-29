// Planification de la prochaine semaine depuis Prospection (Task 06) : logique pure, testable, sans effet.
// La semaine est choisie par un humain ; la cadence (+2/+2/+4) n'est qu'une proposition visible, jamais appliquée seule.
// Semaine métier (année ISO + semaine ISO) ≠ date/heure d'envoi (décision 14) : aucune heure n'est proposée ici.
import {
  addIsoWeeks, compareIsoWeeks, completedStepByState, defaultCadenceWeeks, formatIsoWeekBadge, isoWeekMonday, isoWeekOf,
  isoWeeksInYear, isProspectState, isTerminalProspectState, isValidIsoWeek, prospectStateBadgeLabel, suggestNextActionWeek,
  type IsoWeek
} from '../shared/contactWorkflow';
import { normalizeServerTimestamp } from './serverDate';

/** Origine du pré-remplissage du sélecteur (affichée à l'humain, jamais enregistrée seule). */
export type PlanningPrefillSource = 'current' | 'legacy_date' | 'cadence' | 'this_week';
export type PlanningPrefill = { week: IsoWeek; source: PlanningPrefillSource };
export type CadenceSuggestion = { week: IsoWeek; label: string };
export type WeekOption = { week: number; label: string };
/** Corps de `PATCH /api/prospects/:id/tracking` pour la seule semaine (aucun `status` : l'état n'est jamais touché). */
export type WeekPlanningPatch = { next_action_year: number | null; next_action_week: number | null };

/** Semaine enregistrée (couple ISO valide) ou `null`. */
export function storedWeek(year: unknown, week: unknown): IsoWeek | null {
  if (year === undefined || year === null || year === '' || week === undefined || week === null || week === '') return null;
  const value = { year: Number(year), week: Number(week) };
  return isValidIsoWeek(value) ? value : null;
}

/** Semaine ISO d'une date legacy `planned_contact_at` (`YYYY-MM-DD` ou ISO complet) ; `null` si illisible. */
export function legacyDateWeek(value: unknown): IsoWeek | null {
  const day = typeof value === 'string' ? value.slice(0, 10) : '';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return null;
  const date = new Date(`${day}T00:00:00Z`);
  return Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== day ? null : isoWeekOf(date);
}

/**
 * Proposition de cadence pour un état de séquence (`contacted` +2, `r1` +2, `r2` +4) depuis la semaine où l'état a été choisi
 * (`stateSince`, sinon aujourd'hui). `null` hors séquence (neutre, réponse, RDV, failure, ignoré, code inattendu).
 */
export function cadenceSuggestion(status: unknown, stateSince: unknown, today: Date): CadenceSuggestion | null {
  if (!isProspectState(status)) return null;
  const since = typeof stateSince === 'string' && stateSince ? new Date(stateSince.length === 10 ? `${stateSince}T00:00:00Z` : normalizeServerTimestamp(stateSince)) : null;
  const from = isoWeekOf(since && !Number.isNaN(since.getTime()) ? since : today);
  const week = suggestNextActionWeek(status, from);
  const step = completedStepByState[status];
  if (!week || !step) return null;
  return { week, label: `${prospectStateBadgeLabel(status)} + ${defaultCadenceWeeks[step]} sem.` };
}

/** Pré-remplissage : semaine enregistrée, sinon semaine de l'ancienne date prévue, sinon cadence, sinon semaine courante. */
export function initialPlanningWeek(input: { current: IsoWeek | null; legacyPlannedAt?: unknown; cadence: CadenceSuggestion | null; today: Date }): PlanningPrefill {
  if (input.current) return { week: input.current, source: 'current' };
  const legacy = legacyDateWeek(input.legacyPlannedAt);
  if (legacy) return { week: legacy, source: 'legacy_date' };
  if (input.cadence) return { week: input.cadence.week, source: 'cadence' };
  return { week: isoWeekOf(input.today), source: 'this_week' };
}

/** Change l'année en gardant la semaine ; S53 devient S52 si l'année cible n'a que 52 semaines ISO. */
export const withPlanningYear = (value: IsoWeek, year: number): IsoWeek => ({ year, week: Math.min(value.week, isoWeeksInYear(year)) });
/** Change la semaine dans l'année choisie (bornée au nombre de semaines ISO de cette année). */
export const withPlanningWeek = (value: IsoWeek, week: number): IsoWeek => ({ year: value.year, week: Math.min(Math.max(1, week), isoWeeksInYear(value.year)) });
/** Semaine précédente / suivante avec passage d'année (S52/S53 -> S1 de l'année ISO suivante). */
export const shiftPlanningWeek = (value: IsoWeek, delta: number): IsoWeek => addIsoWeeks(value, delta);

/** Années proposées : année ISO courante -1 à +2, plus l'année sélectionnée si elle sort de cette plage. */
export function planningYearOptions(selected: IsoWeek, today: Date): number[] {
  const current = isoWeekOf(today).year;
  const years = new Set([current - 1, current, current + 1, current + 2, selected.year]);
  return Array.from(years).sort((a, b) => a - b);
}

const mondayFormat = new Intl.DateTimeFormat('fr-FR', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });
export const weekMondayLabel = (value: IsoWeek): string => mondayFormat.format(isoWeekMonday(value));
/** Options de semaine de l'année ISO (`S40 · lun. 28 sept.`), 52 ou 53 selon l'année. */
export function planningWeekOptions(year: number): WeekOption[] {
  return Array.from({ length: isoWeeksInYear(year) }, (_, i) => ({ week: i + 1, label: `${formatIsoWeekBadge({ year, week: i + 1 })} · ${weekMondayLabel({ year, week: i + 1 })}` }));
}

/** Position relative à la semaine courante (affichage d'aide, n'influence aucune règle). */
export function relativeWeekLabel(value: IsoWeek, today: Date): string {
  const n = Math.round((isoWeekMonday(value).getTime() - isoWeekMonday(isoWeekOf(today)).getTime()) / (7 * 86400000));
  if (n === 0) return 'cette semaine';
  const count = `${Math.abs(n)} semaine${Math.abs(n) > 1 ? 's' : ''}`;
  return n > 0 ? `dans ${count}` : `il y a ${count} (échue)`;
}

/** Une semaine peut-elle être posée ? Même règle que le service : jamais sur un `ignored` enregistré. */
export const canPlanWeek = (savedStatus: unknown): boolean => !(isProspectState(savedStatus) && isTerminalProspectState(savedStatus));

/** Corps PATCH : poser une semaine valide, ou effacer (`null`). Lève sur un couple ISO invalide (ex. S53 d'une année à 52 semaines). */
export function weekPlanningPatch(value: IsoWeek | null): WeekPlanningPatch {
  if (value === null) return { next_action_year: null, next_action_week: null };
  const { year, week } = value;
  if (!isValidIsoWeek({ year, week })) throw new Error(`Semaine ISO invalide : S${week} n’existe pas en ${year}`);
  return { next_action_year: year, next_action_week: week };
}

export const sameIsoWeek = (a: IsoWeek | null, b: IsoWeek | null): boolean => (a === null || b === null) ? a === b : compareIsoWeeks(a, b) === 0;

const plannedWeekKeys = new Set(['next_action_year', 'next_action_week', 'contact_year', 'contact_week']);
/**
 * Suivi renvoyé par l'enregistrement de la fiche (`PUT /api/prospects/:id`) sans semaine : la semaine ne se pose que via
 * `PATCH .../tracking` ; un brouillon ancien ne peut donc pas réécrire une semaine planifiée entre-temps.
 */
export function withoutPlannedWeek<T extends Record<string, unknown>>(tracking: T | null | undefined): Partial<T> | null | undefined {
  if (!tracking) return tracking;
  return Object.fromEntries(Object.entries(tracking).filter(([key]) => !plannedWeekKeys.has(key))) as Partial<T>;
}
