// Affichage du dashboard et de la liste Contact (Task 09) : pur, testable.
// Définitions des compteurs : `src/shared/contactDashboard.ts` ; SQL : `src/server/contactDashboard.ts`.
import { formatIsoWeekBadge, compareIsoWeeks, prospectStates, type IsoWeek } from '../shared/contactWorkflow';
import type { ContactCounters, ContactFilter, ContactListQuery, ContactStateFilter, ContactWeekOption } from '../shared/contactDashboard';
import { stateOptionLabel } from './trackingDisplay';

export type ContactCard = { filter: ContactFilter; label: string; count: number; title: string };
/** Carte « À traiter cette semaine » et sa répartition (chaque partie est aussi un filtre), puis « RDV pris ». */
export type ContactCards = { toHandle: ContactCard; breakdown: ContactCard[]; appointments: ContactCard };

export function contactCards(c: ContactCounters, currentWeek: IsoWeek | null): ContactCards {
  const week = currentWeek ? `${formatIsoWeekBadge(currentWeek)} ${currentWeek.year}` : 'semaine courante';
  return {
    toHandle: { filter: 'to_handle', label: 'À traiter cette semaine', count: c.toHandle, title: `Prochaine semaine atteinte (${week}) ou dépassée : premiers contacts, relances et revues` },
    breakdown: [
      { filter: 'first_contact', label: 'Premier contact', count: c.firstContact, title: 'Sans état, semaine atteinte ou dépassée' },
      { filter: 'follow_up', label: 'Relances', count: c.followUp, title: 'Contacté (R1 à faire) ou R1 (R2 à faire), semaine atteinte ou dépassée' },
      { filter: 'review', label: 'Revues R2', count: c.review, title: 'R2 envoyée, semaine de revue atteinte : décision humaine (clôture éventuelle), pas de relance supplémentaire' }
    ],
    appointments: { filter: 'appointments', label: 'RDV pris', count: c.appointments, title: 'Prospects actuellement à l’état « RDV pris » (cumul, toutes semaines)' }
  };
}

/** Libellé court d'une semaine ; l'année est affichée dès qu'elle diffère de l'année ISO courante. */
export function weekOptionLabel(week: IsoWeek, currentWeek: IsoWeek | null): string {
  const badge = formatIsoWeekBadge(week);
  return currentWeek && currentWeek.year === week.year ? badge : `${badge} · ${week.year}`;
}

/** Options du filtre semaine : semaines du planning + semaine courante (toujours proposée, même vide), triées. */
export function weekFilterOptions(weeks: ContactWeekOption[], currentWeek: IsoWeek | null): ContactWeekOption[] {
  const options = [...weeks];
  if (currentWeek && !options.some(w => compareIsoWeeks(w, currentWeek) === 0)) options.push({ ...currentWeek, count: 0 });
  return options.sort(compareIsoWeeks);
}

/** États proposés par le filtre d'état de Contact (`ignored` exclu). */
export const contactStateOptions: { value: ContactStateFilter; label: string }[] = prospectStates
  .filter((s): s is ContactStateFilter => s !== 'ignored')
  .map(value => ({ value, label: stateOptionLabel(value) }));

export const sameContactWeek = (a: IsoWeek | undefined, b: IsoWeek | undefined) => !!a && !!b && compareIsoWeeks(a, b) === 0;

/**
 * Cliquer une carte remplace tous les critères (la liste montre alors exactement les prospects comptés, la carte portant
 * déjà sa fenêtre de temps) ; re-cliquer la carte active revient au planning complet.
 */
export const toggleCardFilter = (query: ContactListQuery, filter: ContactFilter): ContactListQuery => query.filter === filter ? {} : { filter };
/** Choisir une semaine remplace la carte active ; l'état reste combiné. */
export const withWeekFilter = (query: ContactListQuery, week: IsoWeek | undefined): ContactListQuery => ({ week, status: query.status });

/**
 * Prochaine étape déduite de l'état + semaine (docs/02 §3), affichée comme texte dans la liste, jamais comme badge d'état.
 * `r2` + semaine = revue humaine (clôture éventuelle), pas une relance email.
 */
export function nextStepLabel(status: unknown, hasWeek: boolean): string | null {
  if (!hasWeek) return null;
  switch (status) {
    case 'neutral': return 'Premier contact';
    case 'contacted': return 'Relance R1';
    case 'r1': return 'Relance R2';
    case 'r2': return 'Revue (clôture éventuelle)';
    default: return null;
  }
}

/** Message de liste vide selon les critères actifs. */
export function emptyListMessage(query: ContactListQuery): string {
  if (query.filter || query.week || query.status) return 'Aucun prospect pour ces filtres.';
  return 'Aucun prospect planifié : choisissez une prochaine semaine depuis Prospection.';
}
