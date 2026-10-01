// Cartes-filtres du haut de Prospection (Task 07) : lecture concise de la santé de la donnée + premier contact planifié.
// Aucun statut global « Validé / Non validé » (décision 2), aucun compteur `Inconnu` (décision 1), aucune complétude pondérée
// (formule non actée, docs/08 §1). Les métriques de contact (contactés, réponses, RDV) relèvent du dashboard Contact (décision 16).
/** Filtres cliquables de Prospection ; `''` = tous les prospects. */
export const prospectionFilters = ['due', 'incomplete_contact', 'email_to_review'];
export const isProspectionFilter = (value) => typeof value === 'string' && prospectionFilters.includes(value);
