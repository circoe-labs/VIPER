// Cartes-filtres du haut de Prospection (Task 07) : lecture concise de la santé de la donnée + premier contact planifié.
// Aucun statut global « Validé / Non validé » (décision 2), aucun compteur `Inconnu` (décision 1), aucune complétude pondérée
// (formule non actée, docs/08 §1). Les métriques de contact (contactés, réponses, RDV) relèvent du dashboard Contact (décision 16).

/** Filtres cliquables de Prospection ; `''` = tous les prospects. */
export const prospectionFilters = ['due', 'employment_unverified', 'email_to_review'] as const;
export type ProspectionFilter = typeof prospectionFilters[number];

export const isProspectionFilter = (value: unknown): value is ProspectionFilter =>
  typeof value === 'string' && (prospectionFilters as readonly string[]).includes(value);

/**
 * Compteurs factuels (mêmes définitions côté liste filtrée et côté Accueil) :
 * - `total` : prospects en base (une fiche sans email reste une fiche, décision 3) ;
 * - `due` : état neutre avec prochaine semaine ISO atteinte ou échue (premier contact à faire, Task 06) ;
 * - `employmentUnverified` : informations d'emploi jamais vérifiées (`employment_verified_at` absent) — vérification de champ ;
 * - `emailToReview` : aucun email principal actif au statut « Vérifié » (absent, non confirmé ou invalide) — vérification de champ.
 */
export type ProspectionCounters = { total: number; due: number; employmentUnverified: number; emailToReview: number };
