import { filtersOf, type ProspectListCriteria, useProspectionCounters, useProspectionOverview } from '../api/prospection'
import { type Cohort, useCohorts } from '../api/settings'

// The four boxes of the verification space, as Lucie reads her base (colour code of her Excel): « Vérifié » = the
// employment was verified by a person, « Incertitude » = an open « Fonction à vérifier » alert, « Ignoré » = set aside,
// « À vérifier » = everything else. Computed from the existing lists and counters (nothing new on the server).

export type VerificationTab = 'todo' | 'verified' | 'uncertain' | 'ignored' | 'warehouses'

export interface CohortFigure {
  code: string
  startsOn: string | null
  count: number
  // Its first send is still to come (`planned`) or is done.
  planned: boolean
}

export interface VerificationFigures {
  loading: boolean
  total: number
  todo: number
  verified: number
  uncertain: number
  ignored: number
  cohorts: CohortFigure[]
  // Verified people with no campaign cohort (no cohort, or S0).
  withoutCohort: number
}

export function todoCriteria(base: Partial<ProspectListCriteria> = {}): ProspectListCriteria {
  return {
    q: '',
    role: null,
    activity: null,
    referent: null,
    tracking_status: null,
    cohort: null,
    company: null,
    import_batch: null,
    segment: 'never_verified',
    review: null,
    sort: 'file',
    ...base,
  }
}

function cohortFigures(cohorts: Cohort[], today: string): CohortFigure[] {
  return cohorts
    .filter((cohort) => !cohort.out_of_campaign && cohort.current_count > 0)
    .map((cohort) => ({
      code: cohort.code,
      startsOn: cohort.starts_on,
      count: cohort.current_count,
      planned: cohort.starts_on !== null && cohort.starts_on > today,
    }))
    .sort((a, b) => Number(a.code.slice(1)) - Number(b.code.slice(1)))
}

export function useVerificationFigures(): VerificationFigures {
  const criteria = todoCriteria()
  const counters = useProspectionCounters(filtersOf(criteria))
  const overview = useProspectionOverview()
  const cohorts = useCohorts()

  const total = overview.data?.total ?? 0
  const ignored = overview.data?.ignored ?? 0
  const uncertain = overview.data?.uncertain ?? 0
  const figures = cohortFigures(cohorts.data ?? [], counters.data?.today ?? '')
  const verified = overview.data?.employment_validated ?? 0
  const inCampaign = figures.reduce((sum, figure) => sum + figure.count, 0)
  return {
    loading: counters.isPending || overview.isPending || cohorts.isPending,
    total,
    todo: overview.data?.todo ?? 0,
    verified,
    uncertain,
    ignored,
    cohorts: figures,
    withoutCohort: Math.max(verified - inCampaign, 0),
  }
}

export function percent(part: number, whole: number): string {
  return whole > 0 ? `${String(Math.round((part / whole) * 100))} %` : '—'
}
