import type { ActivityEventType, MissionResultStatus } from '../api/missions'

// Single home of the French wording of the supervision tabs (Activité, Résultats, Statistiques). Each concept has the
// singular form (a badge on one entry/card) and the plural form (a count of many, KPI and breakdown rows).
// Factual vocabulary only: what the agent did, found or checked, never its reasoning.

export const EVENT_TYPE_LABELS: Record<ActivityEventType, string> = {
  search: 'Recherche',
  source_opened: 'Source ouverte',
  observation: 'Constat',
  verification: 'Vérification',
  progress: 'Avancement',
  warning: 'Alerte',
  error: 'Erreur',
  decision_summary: 'Bilan',
}

export const EVENT_TYPE_COUNT_LABELS: Record<ActivityEventType, string> = {
  search: 'Recherches',
  source_opened: 'Sources ouvertes',
  observation: 'Observations',
  verification: 'Vérifications',
  progress: 'Avancées',
  warning: 'Avertissements',
  error: 'Erreurs',
  decision_summary: 'Synthèses de décision',
}

export const RESULT_STATUS_LABELS: Record<MissionResultStatus, string> = {
  pending_review: 'À relire',
  accepted: 'Validé',
  rejected: 'Rejeté',
  superseded: 'Remplacé',
}

export const RESULT_STATUS_COUNT_LABELS: Record<MissionResultStatus, string> = {
  pending_review: 'À relire',
  accepted: 'Acceptés',
  rejected: 'Refusés',
  superseded: 'Remplacés',
}
