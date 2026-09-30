// Affichage du haut de Prospection (Task 07, retour « PARTIE PROSPECTION ») : pur, testable.
// Définitions des compteurs : `src/shared/prospectionDashboard.ts` ; SQL : `src/server/prospectionDashboard.ts`.
import type { ProspectionCounters, ProspectionFilter } from '../shared/prospectionDashboard';

export type ProspectionCard = { label: string; count: number; filter: ProspectionFilter | ''; title: string };

/** 4 cartes, toutes cliquables comme filtres de la liste. */
export function prospectionCards(c: ProspectionCounters): ProspectionCard[] {
  return [
    { label: 'Tous', count: c.total, filter: '', title: 'Tous les prospects en base' },
    { label: 'Contacts dus', count: c.due, filter: 'due', title: 'Sans état, prochaine semaine atteinte ou dépassée : premier contact à faire' },
    { label: 'Coordonnées incomplètes', count: c.incompleteContact, filter: 'incomplete_contact', title: 'Email principal ou téléphone principal manquant' },
    { label: 'Emails à fiabiliser', count: c.emailToReview, filter: 'email_to_review', title: 'Pas d’email principal vérifié (absent, non confirmé ou invalide)' }
  ];
}

export const emptyProspectionCounters: ProspectionCounters = { total: 0, due: 0, incompleteContact: 0, emailToReview: 0 };
