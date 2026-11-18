import type { Prospect } from '../api/prospects'
import { useProspectProximity } from '../api/proximity'
import { ApiError } from '../api/client'
import { criteriaSentence, splitCriteria } from './completenessView'
import type { CompletenessView, IndicatorState, ProximityView } from './indicators'
import { describeEnds, describePath } from './proximityView'

// The one seam where the indicator slots get their data: the fiche state from the prospect's own read model
// (`data_quality`, no extra request), the proximity score from its endpoint.

// `null` data_quality = durable opposition (« Écarté »): not evaluated, said as such. No prospect yet (new form): nothing.
export function completenessIndicator(prospect: Prospect | null): IndicatorState<CompletenessView> {
  if (prospect === null) return { status: 'unavailable' }
  const quality = prospect.data_quality
  if (quality === null) return { status: 'unavailable', reason: 'Écarté : pas d’évaluation' }
  const { todo, done } = splitCriteria(quality)
  return {
    status: 'ready',
    value: {
      state: quality.state,
      label: quality.state_label,
      description: [quality.state_description, quality.summary].filter(Boolean).join(' '),
      missing: todo.map((criterion) => criterion.label),
      strong: done.map((criterion) => criterion.label),
      sentence: criteriaSentence(quality.criteria),
    },
  }
}

export function useCompletenessIndicator(prospect: Prospect | null): IndicatorState<CompletenessView> {
  return completenessIndicator(prospect)
}

export function useProximityIndicator(prospectId: string | null): IndicatorState<ProximityView> {
  const query = useProspectProximity(prospectId)
  if (prospectId === null) return { status: 'unavailable' }
  if (query.isPending) return { status: 'loading' }
  if (query.isError) {
    const detail = query.error instanceof ApiError ? ` (${query.error.message})` : ''
    return {
      status: 'error',
      message: `Le score de proximité n’a pas pu être calculé${detail}.`,
      onRetry: () => {
        void query.refetch()
      },
    }
  }
  const { data } = query
  const [best] = data.paths
  return {
    status: 'ready',
    value: {
      prospectId: data.prospect_id,
      state: data.state,
      total: data.score,
      pathCount: data.path_count,
      bestPath: best ? describePath(best) : null,
      bestPathEnds: best ? describeEnds(best) : null,
      maxHops: data.max_hops,
    },
  }
}
