// Dashboard Contact (Task 09) : seules les deux métriques actées (décisions 17 et 18, docs/08 §2), cliquables comme filtres.
// Codes et types partagés client/serveur ; SQL unique dans `src/server/contactDashboard.ts` (liste filtrée = compteurs).
import { isProspectState, isValidIsoWeek } from './contactWorkflow.js';
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
export const contactFilters = ['to_handle', 'first_contact', 'follow_up', 'review', 'appointments'];
export const isContactFilter = (value) => typeof value === 'string' && contactFilters.includes(value);
export const isContactStateFilter = (value) => isProspectState(value) && value !== 'ignored';
export const emptyContactCounters = { toHandle: 0, firstContact: 0, followUp: 0, review: 0, appointments: 0 };
const blank = (value) => value === undefined || value === null || value === '';
/** Validation des paramètres de requête (`filter`, `year` + `week`, `status`) ; aucune valeur inconnue n'est ignorée silencieusement. */
export function parseContactListQuery(params) {
    const query = {};
    if (!blank(params.filter)) {
        if (!isContactFilter(params.filter))
            return { ok: false, error: 'Filtre Contact inconnu' };
        query.filter = params.filter;
    }
    if (!blank(params.year) || !blank(params.week)) {
        const week = { year: Number(params.year), week: Number(params.week) };
        if (blank(params.year) || blank(params.week) || !isValidIsoWeek(week))
            return { ok: false, error: 'Semaine ISO invalide (année et semaine requises)' };
        query.week = week;
    }
    if (!blank(params.status)) {
        if (!isContactStateFilter(params.status))
            return { ok: false, error: 'État non filtrable dans Contact' };
        query.status = params.status;
    }
    return { ok: true, query };
}
/** Paramètres d'URL correspondant à une requête (inverse de `parseContactListQuery`). */
export function contactListSearchParams(query) {
    const params = new URLSearchParams();
    if (query.filter)
        params.set('filter', query.filter);
    if (query.week) {
        params.set('year', String(query.week.year));
        params.set('week', String(query.week.week));
    }
    if (query.status)
        params.set('status', query.status);
    return params.toString();
}
