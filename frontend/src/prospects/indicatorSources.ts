import type { CompletenessView, IndicatorState, ProximityView } from './indicators'

// The one seam where the indicator slots get their data. S2 returns the prospect's completeness state from its read
// model, S3 the proximity score (query on the person-link graph); until then both slots say « unavailable » rather
// than inventing a figure on the client. S2 and S3 add the prospect id as argument. Replacing this stub is part of the S7 integration.
export function useCompletenessIndicator(): IndicatorState<CompletenessView> {
  return { status: 'unavailable' }
}

export function useProximityIndicator(): IndicatorState<ProximityView> {
  return { status: 'unavailable' }
}
