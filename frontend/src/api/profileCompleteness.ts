// Fiche completeness (« Qualité de la fiche »), slice S2 — contract of app/services/prospect_data_quality.py.
// The user sees a named state with an explanation and a criterion breakdown, never a number. The backend still sends
// a private numeric total/band/points as a compatibility adapter (see `DataQualityScore` in prospects.ts): this
// contract deliberately does not mention them, so nothing built on it can display a score.

// From least to most provided.
export type ProfileCompletenessState = 'incomplete' | 'usable' | 'rich' | 'very_rich'

export type CompletenessCriterionStatus = 'met' | 'partial' | 'missing'

export interface ProfileCompletenessCriterion {
  id: string
  label: string
  status: CompletenessCriterionStatus
  // Short French explanation of what was found (« Aucun e-mail actif »).
  detail: string
}

export interface ProfileCompleteness {
  state: ProfileCompletenessState
  // French word of the state (« Incomplète », « Exploitable », « Fournie », « Très fournie »).
  state_label: string
  // What the state means, for the tooltip.
  state_description: string
  // One factual sentence naming what is missing, or saying the record is complete.
  summary: string
  criteria: ProfileCompletenessCriterion[]
}
