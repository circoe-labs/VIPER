import type { ProfileCompleteness } from '../api/profileCompleteness'
import type { ProximityState } from '../api/proximity'

// Contracts of the two indicator slots at the top of the Profil tab. The values are computed by the backend (fiche
// completeness state: `prospect.data_quality`, services/prospect_data_quality.py; proximity score:
// GET /links/proximity/prospect/{id}, services/person_proximity.py); the front only displays them and never derives a
// score. Wired in indicatorSources.ts.
export type IndicatorState<T> =
  | { status: 'loading' }
  // Nothing to show, with the reason when there is a specific one (a prospect under opposition is not evaluated).
  | { status: 'unavailable'; reason?: string }
  | { status: 'error'; message: string; onRetry?: () => void }
  | { status: 'ready'; value: T }

// The fiche's named state (never a 0-100 figure) with the backend's own words; `missing` / `strong` come from its
// criteria and feed the « à compléter » tooltip.
export interface CompletenessView {
  state: ProfileCompleteness['state']
  label: string
  description: string
  missing: string[]
  strong: string[]
  // One sentence built from the backend's criterion details, shown under the state word (no number).
  sentence: string
}

// Proximity read model, already explained by the backend: `bestPath` is its best path worded from the member to the
// prospect (null when there is none), `state` says why a score of 0 is 0.
export interface ProximityView {
  // The prospect the score is about: the « Graph » button opens the relations graph on it (absent = no button).
  prospectId?: string
  state: ProximityState
  total: number
  pathCount: number
  bestPath: string | null
  // « Membre → Prospect »: the two ends of the best path (null when there is none).
  bestPathEnds: string | null
  maxHops: number
}
