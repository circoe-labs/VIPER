import type { ScoreBand, ScoreContribution } from '../api/prospects'
import type { ScoreRingTone } from '../ui/ScoreRing'

// Reading of a ProspectScore (ProspectScoreCard.tsx). The band comes from the backend (`score.band`): nothing here
// knows a threshold. The words are the non-colour carrier of the band.

export const BAND_LABELS: Record<ScoreBand, string> = { red: 'Faible', yellow: 'Moyen', green: 'Élevé' }

export const BAND_TONES: Record<ScoreBand, ScoreRingTone> = { red: 'danger', yellow: 'warning', green: 'success' }

// Contributions by decreasing weight of what they bring: the positives (and zeros) from the largest, then the negatives
// from the most damaging; equal deltas keep the API's order (a stable sort).
export function sortContributions(contributions: readonly ScoreContribution[]): ScoreContribution[] {
  const rank = (delta: number) => (delta >= 0 ? 0 : 1)
  return [...contributions].sort((a, b) => rank(a.delta) - rank(b.delta) || (a.delta >= 0 ? b.delta - a.delta : a.delta - b.delta))
}

// « +5 », « -10 », « 0 » (the sign is text, never only colour).
export function signedDelta(delta: number): string {
  return delta > 0 ? `+${String(delta)}` : String(delta)
}

// Where a contribution comes from, in words (`null` = nothing traceable).
export function contributionSource(contribution: ScoreContribution): string {
  if (contribution.source_type === 'note') return 'Note du prospect'
  return contribution.source_type ? `Source : ${contribution.source_type}` : 'Source non précisée'
}
