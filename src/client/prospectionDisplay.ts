// Affichage du haut de Prospection et de la colonne « Emploi » des cartes (Task 07) : pur, testable.
// Définitions des compteurs : `src/shared/prospectionDashboard.ts` ; SQL : `src/server/prospectionDashboard.ts`.
import type { ProspectionCounters, ProspectionFilter } from '../shared/prospectionDashboard';

export type ProspectionCard = { label: string; count: number; filter: ProspectionFilter | ''; title: string };

/** 4 cartes, toutes cliquables comme filtres de la liste. */
export function prospectionCards(c: ProspectionCounters): ProspectionCard[] {
  return [
    { label: 'Tous', count: c.total, filter: '', title: 'Tous les prospects en base' },
    { label: 'Contacts dus', count: c.due, filter: 'due', title: 'Sans état, prochaine semaine atteinte ou dépassée : premier contact à faire' },
    { label: 'Emploi à vérifier', count: c.employmentUnverified, filter: 'employment_unverified', title: 'Informations d’emploi jamais vérifiées' },
    { label: 'Emails à fiabiliser', count: c.emailToReview, filter: 'email_to_review', title: 'Pas d’email principal vérifié (absent, non confirmé ou invalide)' }
  ];
}

export const emptyProspectionCounters: ProspectionCounters = { total: 0, due: 0, employmentUnverified: 0, emailToReview: 0 };

export type EmploymentCheck = { tone: 'verified' | 'never'; label: string; detail: string };

/** Vérification des informations d'emploi (propriété de champ, pas un statut global du prospect — décision 2). */
export function employmentCheck(verifiedAt: string | null | undefined, formatDate: (value: string) => string): EmploymentCheck {
  return verifiedAt
    ? { tone: 'verified', label: 'Vérifié', detail: formatDate(verifiedAt) }
    : { tone: 'never', label: 'Non vérifié', detail: 'À vérifier' };
}
