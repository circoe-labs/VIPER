import type { CompletenessCriterionStatus, ProfileCompleteness, ProfileCompletenessState } from '../api/profileCompleteness'
import type { StatusTone } from '../ui/Badge'

// Reading of a ProfileCompleteness (DataQualityCard.tsx). The state and its words come from the backend; nothing here
// knows a threshold. The step only drives the segmented meter (decorative: the label carries the meaning).

export const COMPLETENESS_STEPS: Record<ProfileCompletenessState, number> = { incomplete: 1, usable: 2, rich: 3, very_rich: 4 }
export const COMPLETENESS_STEP_COUNT = 4

// Incomplete asks for work (warning), a usable fiche is informative, a provided one is positive.
export const COMPLETENESS_TONES: Record<ProfileCompletenessState, StatusTone> = {
  incomplete: 'warning',
  usable: 'info',
  rich: 'success',
  very_rich: 'success',
}

// A state the frontend does not know (newer backend) still renders, neutral and without a meter.
export function completenessStep(state: string): number {
  return (COMPLETENESS_STEPS as Record<string, number | undefined>)[state] ?? 0
}

export function completenessTone(state: string): StatusTone {
  return (COMPLETENESS_TONES as Record<string, StatusTone | undefined>)[state] ?? 'neutral'
}

export const CRITERION_STATUS_LABELS: Record<CompletenessCriterionStatus, string> = {
  met: 'Complet',
  partial: 'Partiel',
  missing: 'Manquant',
}

// Criteria to work on first (missing, then partial) and the ones already acquired, API order kept inside each group.
export function splitCriteria(completeness: ProfileCompleteness) {
  const todo = completeness.criteria.filter((criterion) => criterion.status !== 'met')
  return {
    todo: [...todo.filter((c) => c.status === 'missing'), ...todo.filter((c) => c.status === 'partial')],
    done: completeness.criteria.filter((criterion) => criterion.status === 'met'),
  }
}
