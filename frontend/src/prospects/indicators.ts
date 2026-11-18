import type { StatusTone } from '../ui/Badge'

// Contracts of the two indicator slots at the top of the Profil tab (prospect-sheet redesign S1). The values are
// computed by the backend (S2: fiche completeness state, S3: proximity score); the front only displays them and
// never derives a score. Until a slice delivers its read model the slot is `unavailable`.
export type IndicatorState<T> =
  | { status: 'loading' }
  | { status: 'unavailable' }
  | { status: 'error'; message: string }
  | { status: 'ready'; value: T }

// Semantic state of the fiche (S2 contract: no 0-100 figure is ever shown for it).
export type CompletenessLevel = 'incomplete' | 'usable' | 'rich' | 'very_rich'

export interface CompletenessView {
  level: CompletenessLevel
  // What is missing / what is strong, as short French phrases from the backend (shown in a tooltip).
  missing: string[]
  strong: string[]
}

// Proximity read model (S3 contract): 0-100 from the person-link graph, with its explanation.
export interface ProximityView {
  total: number
  pathCount: number
  // Best path from a Circoe member, already worded by the backend (e.g. « Robin → Yamina »); null when none.
  bestPath: string | null
}

export const COMPLETENESS_LABELS: Record<CompletenessLevel, string> = {
  incomplete: 'Incomplète',
  usable: 'Exploitable',
  rich: 'Fournie',
  very_rich: 'Très fournie',
}

// Colour only reinforces the word (never the only signal).
export const COMPLETENESS_TONES: Record<CompletenessLevel, StatusTone> = {
  incomplete: 'warning',
  usable: 'info',
  rich: 'success',
  very_rich: 'success',
}

// TEMPORARY (removed at S7, when S2 and S3 are wired): typed fixtures for tests of the ready states.
export const COMPLETENESS_FIXTURE: CompletenessView = {
  level: 'usable',
  missing: ['Aucun téléphone vérifié', 'Intitulé exact absent'],
  strong: ['E-mail vérifié', 'Entreprise renseignée'],
}

export const PROXIMITY_FIXTURE: ProximityView = { total: 64, pathCount: 2, bestPath: 'Robin → Yamina' }
