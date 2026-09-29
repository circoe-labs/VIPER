// Workbench Contact (Task 10, décisions 10, 19, 29) : fiche prospect à gauche, zone mail à droite. Logique pure, testable.
// - la fiche est en lecture : seuls l'état et la prochaine semaine se choisissent ici (PATCH tracking), toujours à la main ;
// - le changement vers un état qui annule la séquence (`response_received`, `appointment_obtained`, `ignored`) est confirmé ;
// - la sélection survit aux rafraîchissements : un prospect sorti des filtres reste ouvert, avec une mention explicite.
import {
  cancelsFutureMessages, formatIsoWeekBadge, hasDefaultNextAction, isProspectState, isTerminalProspectState, prospectStates,
  type ProspectState
} from '../shared/contactWorkflow';
import { historyStatusLabel, selectableState, stateOptionLabel } from './trackingDisplay';
import { storedWeek } from './weekPlanning';

type Row = Record<string, unknown>;
/** Réponse de `GET /api/prospects/:id` (champs utilisés ici). */
export type ProspectDetail = {
  prospect: Row; company: Row | null; role?: string | null; emails: Row[]; phones: Row[];
  tracking: Row | null; trackingHistory: Row[];
};

export type SummaryEmail = { address: string; primary: boolean; verification: string };
export type SummaryPhone = { number: string; type: string; primary: boolean; verification: string };
export type SummaryHistoryEntry = { id: string; label: string; at: string | null; by: string };
export type ProspectSummaryModel = {
  id: string; name: string; civility: string | null; jobTitle: string | null; role: string | null;
  company: { name: string; website: string | null; domain: string | null } | null;
  employmentVerifiedAt: string | null;
  emails: SummaryEmail[]; phones: SummaryPhone[];
  doNotContact: { reason: string | null } | null;
  tracking: { status: string; year: number | null; week: number | null; stateSince: string | null };
  history: SummaryHistoryEntry[];
};

const text = (value: unknown): string | null => typeof value === 'string' && value.trim() ? value.trim() : null;
const verificationLabels: Record<string, string> = { verified: 'Vérifié', unverified: 'À vérifier', invalid: 'Invalide', unknown: 'Non confirmé' };
const phoneTypes: Record<string, string> = { mobile: 'Mobile', landline: 'Fixe', other: 'Autre' };
const actorLabels: Record<string, string> = { human: 'Manuel', import: 'Import', system: 'Système', agent: 'Agent' };
export const HISTORY_LIMIT = 6;

/** Modèle d'affichage de la fiche (lecture seule) ; emails/téléphones principaux en premier. */
export function prospectSummary(detail: ProspectDetail): ProspectSummaryModel {
  const p = detail.prospect;
  const tracking = detail.tracking;
  const status = text(tracking?.status) ?? 'neutral';
  const week = storedWeek(tracking?.next_action_year, tracking?.next_action_week);
  const doNotContact = p.contactability_status === 'do_not_contact';
  const history = detail.trackingHistory ?? [];
  const byPrimary = (a: Row, b: Row) => Number(Boolean(b.is_primary)) - Number(Boolean(a.is_primary));
  return {
    id: String(p.id),
    name: [text(p.first_name), text(p.last_name)].filter(Boolean).join(' ') || 'Nom non renseigné',
    civility: text(p.civility),
    jobTitle: text(p.exact_job_title),
    role: text(detail.role),
    company: detail.company ? { name: text(detail.company.display_name) ?? 'Entreprise sans nom', website: text(detail.company.website_url), domain: text(detail.company.email_domain) } : null,
    employmentVerifiedAt: text(p.employment_verified_at),
    emails: [...(detail.emails ?? [])].sort(byPrimary).filter(e => text(e.address)).map(e => ({
      address: String(e.address), primary: Boolean(e.is_primary), verification: verificationLabels[String(e.verification_status)] ?? 'Non confirmé'
    })),
    phones: [...(detail.phones ?? [])].sort(byPrimary).filter(x => text(x.number)).map(x => ({
      number: String(x.number), type: phoneTypes[String(x.type)] ?? 'Autre', primary: Boolean(x.is_primary),
      verification: verificationLabels[String(x.verification_status)] ?? 'Non confirmé'
    })),
    doNotContact: doNotContact ? { reason: text(p.do_not_contact_reason) } : null,
    tracking: {
      status, year: week?.year ?? null, week: week?.week ?? null,
      stateSince: text(history.find(h => h.to_status === status)?.changed_at)
    },
    history: history.slice(0, HISTORY_LIMIT).map((h, i) => ({
      id: String(h.id ?? i), label: historyStatusLabel(h.to_status, doNotContact), at: text(h.changed_at), by: actorLabels[String(h.actor_type)] ?? 'Autre'
    }))
  };
}

// --- Sélection de l'état (choix humain, 8 états du contrat) ---
export type StateOption = { value: ProspectState; label: string };
export const workbenchStateOptions: StateOption[] = prospectStates.map(value => ({ value, label: stateOptionLabel(value) }));
/** Même règle que le service : aucun changement d'état depuis un `ignored` enregistré. */
export const isStateLocked = (savedStatus: unknown): boolean => isProspectState(savedStatus) && isTerminalProspectState(savedStatus);
/** Valeur initiale du sélecteur (code hors contrat = `null`, affiché à part). */
export const initialStateChoice = (savedStatus: unknown, doNotContact: boolean): ProspectState | null => selectableState(savedStatus, doNotContact);

export type StateChangeConfirmation = { title: string; lines: string[]; confirmLabel: string };

/**
 * Confirmation exigée avant un état qui annule la séquence (décision 29). Le texte n'affirme jamais qu'un message existe :
 * l'annulation porte sur « les messages futurs non envoyés, s'il y en a ». `null` = enregistrement direct.
 */
export function stateChangeConfirmation(from: unknown, to: ProspectState, week: { year: number | null; week: number | null }): StateChangeConfirmation | null {
  if (from === to || !cancelsFutureMessages(to)) return null;
  const label = stateOptionLabel(to);
  const lines = ['Les messages futurs non envoyés de la séquence (Contact, R1, R2) seront annulés, s’il y en a. Les messages déjà envoyés restent consultables.'];
  const planned = storedWeek(week.year, week.week);
  if (planned) lines.push(`La prochaine semaine (${formatIsoWeekBadge(planned)} ${planned.year}) sera retirée.`);
  if (to === 'ignored') {
    lines.push('« Ignoré » est définitif : le prospect sera marqué « À ne plus contacter », sortira de Contact et son état ne pourra plus être modifié.');
  } else if (planned) {
    lines.push('Une nouvelle semaine pourra être reposée ensuite si nécessaire.');
  }
  return { title: `Passer à « ${label} » ?`, lines, confirmLabel: to === 'ignored' ? 'Confirmer « Ignoré » (définitif)' : `Confirmer « ${label} »` };
}

/** Effet visible avant d'appliquer un état sans confirmation (ex. `failure` retire la semaine). */
export function stateChangeHint(from: unknown, to: ProspectState, week: { year: number | null; week: number | null }): string | null {
  if (from === to || cancelsFutureMessages(to)) return null;
  if (!hasDefaultNextAction(to) && storedWeek(week.year, week.week)) return 'Cet état retire la prochaine semaine planifiée.';
  return null;
}

/** Corps de `PATCH /api/prospects/:id/tracking` pour l'état seul (aucune semaine envoyée). */
export const stateChangePatch = (to: ProspectState) => ({ status: to });

/** Réponse (partielle) de `PATCH /api/prospects/:id/tracking`. */
export type TrackingMutation = {
  tracking: Row; stateChanged: boolean; doNotContactReinforced: boolean; cancelledMessages: number; previousStatus?: string | null;
};

/** Annonce après enregistrement de l'état (lue par `aria-live`). */
export function stateChangeNotice(result: TrackingMutation, previousWeek: { year: number | null; week: number | null }): string {
  const status = result.tracking.status;
  const parts = [result.stateChanged ? `État enregistré : ${isProspectState(status) ? stateOptionLabel(status) : String(status)}.` : 'État inchangé.'];
  if (storedWeek(previousWeek.year, previousWeek.week) && !storedWeek(result.tracking.next_action_year, result.tracking.next_action_week)) parts.push('Prochaine semaine retirée.');
  if (result.cancelledMessages > 0) parts.push(`${result.cancelledMessages} message${result.cancelledMessages > 1 ? 's' : ''} futur${result.cancelledMessages > 1 ? 's' : ''} annulé${result.cancelledMessages > 1 ? 's' : ''}.`);
  if (result.doNotContactReinforced) parts.push('Prospect marqué « À ne plus contacter ».');
  return parts.join(' ');
}

// --- Sélection stable dans la liste Contact ---
export type SelectionPresence = 'none' | 'listed' | 'pending' | 'outside_list';

/**
 * Situation du prospect sélectionné par rapport à la liste affichée. Un rafraîchissement ou un filtre ne ferme jamais la fiche :
 * si le prospect n'est plus listé (état changé, semaine déplacée, filtre), la fiche reste ouverte avec une mention.
 */
export function selectionPresence(selectedId: string | null, listedIds: readonly string[], listLoading: boolean): SelectionPresence {
  if (!selectedId) return 'none';
  if (listedIds.includes(selectedId)) return 'listed';
  return listLoading ? 'pending' : 'outside_list';
}

/** Mention affichée en tête de fiche quand le prospect n'est plus dans la liste courante. */
export function presenceNotice(presence: SelectionPresence, status: unknown): string | null {
  if (presence !== 'outside_list') return null;
  if (status === 'ignored') return 'Ignoré : ce prospect ne figure plus dans Contact. La fiche reste ouverte jusqu’à la prochaine sélection.';
  return 'Ce prospect ne correspond plus aux filtres de la liste. La fiche reste ouverte jusqu’à la prochaine sélection.';
}

const dateFormat = new Intl.DateTimeFormat('fr-FR', { dateStyle: 'medium' });
const dateTimeFormat = new Intl.DateTimeFormat('fr-FR', { dateStyle: 'medium', timeStyle: 'short' });
/** Date lisible (`YYYY-MM-DD` ou ISO) ; valeur illisible renvoyée telle quelle. */
export function displayDate(value: string | null, withTime = false): string {
  if (!value) return '—';
  const d = new Date(value.length === 10 ? `${value}T12:00:00` : value);
  if (Number.isNaN(d.getTime())) return value;
  return (withTime ? dateTimeFormat : dateFormat).format(d);
}
