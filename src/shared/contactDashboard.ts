// Dashboard Contact (Task 09) : seules les deux métriques actées (décisions 17 et 18, docs/08 §2), cliquables comme filtres.
// Codes et types partagés client/serveur ; SQL unique dans `src/server/contactDashboard.ts` (liste filtrée = compteurs).
import { isProspectState, isValidIsoWeek, type IsoWeek, type ProspectState } from './contactWorkflow.js';

/**
 * Filtres des cartes (le prospect `ignored` est toujours exclu de Contact) :
 * - `to_handle` : « À traiter cette semaine » = état `neutral`, `contacted`, `r1` ou `r2` avec prochaine semaine ISO
 *   atteinte (semaine courante) ou échue (jamais traitée : aucun état ne change seul) ; union exacte des trois suivants ;
 * - `first_contact` : premier contact = `neutral` + semaine atteinte/échue (même définition que « Contacts dus » de Prospection) ;
 * - `follow_up` : relance = `contacted` (R1 à faire) ou `r1` (R2 à faire) + semaine atteinte/échue ;
 * - `review` : `r2` + semaine atteinte/échue = revue humaine / clôture éventuelle (décision 13), pas une relance email ;
 * - `appointments` : « RDV pris » cumulés = prospects dont l'état courant est `appointment_obtained`, sans fenêtre de temps
 *   (un choix humain corrigé ne reste pas compté ; `appointment_at` n'est pas requis, il n'est pas posé par le suivi manuel).
 */
export const contactFilters = ['to_handle', 'first_contact', 'follow_up', 'review', 'appointments'] as const;
export type ContactFilter = typeof contactFilters[number];
export const isContactFilter = (value: unknown): value is ContactFilter =>
  typeof value === 'string' && (contactFilters as readonly string[]).includes(value);

/** États filtrables dans Contact : tous sauf `ignored` (terminal, hors Contact). */
export type ContactStateFilter = Exclude<ProspectState, 'ignored'>;
export const isContactStateFilter = (value: unknown): value is ContactStateFilter => isProspectState(value) && value !== 'ignored';

/** `toHandle = firstContact + followUp + review` (mêmes conditions, disjointes par état). */
export type ContactCounters = { toHandle: number; firstContact: number; followUp: number; review: number; appointments: number };
export const emptyContactCounters: ContactCounters = { toHandle: 0, firstContact: 0, followUp: 0, review: 0, appointments: 0 };

/** Semaine présente dans le planning (prospects non ignorés ayant cette prochaine semaine), pour le sélecteur de semaine. */
export type ContactWeekOption = IsoWeek & { count: number };
/** Réponse de `GET /api/contact/dashboard`. `currentWeek` = semaine ISO du serveur (référence de « cette semaine »). */
export type ContactDashboard = { currentWeek: IsoWeek; counters: ContactCounters; weeks: ContactWeekOption[] };

/**
 * Critères de `GET /api/contact/prospects` (combinés en ET). Sans aucun critère : prospects ayant une prochaine semaine
 * (planning), jamais de prospect sans échéance. Un filtre d'état explicite montre aussi ceux sans échéance.
 */
export type ContactListQuery = { filter?: ContactFilter; week?: IsoWeek; status?: ContactStateFilter };

/** Ligne de `GET /api/contact/prospects` (tri : prochaine semaine, sans semaine en dernier, puis nom). */
export type ContactListItem = {
  id: string; first_name: string | null; last_name: string | null; exact_job_title: string | null; company: string; role: string | null;
  primary_email: string | null; tracking_status: string; next_action_year: number | null; next_action_week: number | null;
};

export type ContactListQueryResult = { ok: true; query: ContactListQuery } | { ok: false; error: string };

const blank = (value: unknown) => value === undefined || value === null || value === '';

/** Validation des paramètres de requête (`filter`, `year` + `week`, `status`) ; aucune valeur inconnue n'est ignorée silencieusement. */
export function parseContactListQuery(params: Record<string, unknown>): ContactListQueryResult {
  const query: ContactListQuery = {};
  if (!blank(params.filter)) {
    if (!isContactFilter(params.filter)) return { ok: false, error: 'Filtre Contact inconnu' };
    query.filter = params.filter;
  }
  if (!blank(params.year) || !blank(params.week)) {
    const week = { year: Number(params.year), week: Number(params.week) };
    if (blank(params.year) || blank(params.week) || !isValidIsoWeek(week)) return { ok: false, error: 'Semaine ISO invalide (année et semaine requises)' };
    query.week = week;
  }
  if (!blank(params.status)) {
    if (!isContactStateFilter(params.status)) return { ok: false, error: 'État non filtrable dans Contact' };
    query.status = params.status;
  }
  return { ok: true, query };
}

/** Paramètres d'URL correspondant à une requête (inverse de `parseContactListQuery`). */
export function contactListSearchParams(query: ContactListQuery): string {
  const params = new URLSearchParams();
  if (query.filter) params.set('filter', query.filter);
  if (query.week) { params.set('year', String(query.week.year)); params.set('week', String(query.week.week)); }
  if (query.status) params.set('status', query.status);
  return params.toString();
}
