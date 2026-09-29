// Décisions d'affichage du suivi (badge d'état, badge semaine, historique) : pures, testables, sans logique de prochaine étape.
// Libellés et semaines viennent uniquement du contrat partagé `src/shared/contactWorkflow.ts`.
import {
  formatIsoWeekBadge, isLegacyTrackingStatus, isProspectState, isoWeekMonday, isValidIsoWeek, mapLegacyTrackingStatus,
  prospectStateBadgeLabel, type ProspectState
} from '../shared/contactWorkflow';

export type StateBadgeTone = 'sequence' | 'response' | 'appointment' | 'failure' | 'ignored' | 'unexpected';
export type StateBadgeModel = { label: string; tone: StateBadgeTone; title: string };
export type WeekBadgeModel = { label: string; title: string; year: number; week: number };

const stateTones: Readonly<Record<Exclude<ProspectState, 'neutral'>, StateBadgeTone>> = {
  contacted: 'sequence', r1: 'sequence', r2: 'sequence', response_received: 'response',
  appointment_obtained: 'appointment', failure: 'failure', ignored: 'ignored'
};
const NEUTRAL_OPTION_LABEL = 'Aucun état';

/** Badge d'état : `null` = aucun badge (neutre ou suivi absent, décision 4). Un code hors contrat est signalé tel quel, jamais masqué. */
export function stateBadgeModel(status: unknown): StateBadgeModel | null {
  if (status === undefined || status === null || status === '') return null;
  if (isProspectState(status)) {
    const label = prospectStateBadgeLabel(status);
    return label === null || status === 'neutral' ? null : { label, tone: stateTones[status], title: `État : ${label}` };
  }
  const code = String(status);
  return { label: code, tone: 'unexpected', title: `État hors contrat « ${code} » : à revoir dans la fiche` };
}

const mondayFormat = new Intl.DateTimeFormat('fr-FR', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });

/** Badge de prochaine échéance (`S40`, année en infobulle) ; `null` si aucune semaine ou couple ISO invalide. */
export function weekBadgeModel(year: unknown, week: unknown): WeekBadgeModel | null {
  if (year === undefined || year === null || year === '' || week === undefined || week === null || week === '') return null;
  const value = { year: Number(year), week: Number(week) };
  if (!isValidIsoWeek(value)) return null;
  return {
    ...value,
    label: formatIsoWeekBadge(value),
    title: `Prochaine échéance : semaine ${value.week} de ${value.year} (${mondayFormat.format(isoWeekMonday(value))})`
  };
}

/** Libellé d'une option du sélecteur d'état (choix humain) : l'état neutre n'a pas de badge mais doit rester sélectionnable. */
export const stateOptionLabel = (state: ProspectState): string => prospectStateBadgeLabel(state) ?? NEUTRAL_OPTION_LABEL;

/** Valeur du sélecteur : état du contrat, code legacy (brouillon ancien) converti, sinon `null` (hors contrat, à afficher à part). */
export function selectableState(status: unknown, doNotContact: boolean): ProspectState | null {
  if (status === undefined || status === null || status === '') return 'neutral';
  if (isProspectState(status)) return status;
  if (isLegacyTrackingStatus(status)) return mapLegacyTrackingStatus(status, doNotContact);
  return null;
}

/** Libellé d'une ligne d'historique : l'historique ancien n'est jamais réécrit, ses codes legacy sont lus via le mapping Task 03. */
export function historyStatusLabel(status: unknown, doNotContact: boolean): string {
  if (isProspectState(status)) return stateOptionLabel(status);
  if (isLegacyTrackingStatus(status)) return `${stateOptionLabel(mapLegacyTrackingStatus(status, doNotContact))} (ancien suivi)`;
  return `État hors contrat (${String(status ?? '—')})`;
}
