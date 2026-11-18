import type { ProximityPath } from '../api/proximity'
import type { ScoreRingTone } from '../ui/ScoreRing'

// Display bands of the proximity score (display only: the figure and its explanation come from the backend).
export function proximityTone(score: number): ScoreRingTone {
  if (score >= 67) return 'success'
  if (score >= 34) return 'warning'
  return 'neutral'
}

export function proximityLabel(score: number): string {
  if (score >= 67) return 'Proche'
  if (score >= 34) return 'Accessible'
  return 'Lointain'
}

export function hopsLabel(hops: number): string {
  return hops === 1 ? 'Lien direct' : `${String(hops)} liens`
}

// « Robin → Paul (amis, 80) → Anne (frère, 100) » read from the member to the prospect.
export function describePath(path: ProximityPath): string {
  return path.people
    .map((person, index) => {
      const edge = index > 0 ? path.edges[index - 1] : undefined
      return edge ? `${person.name} (${edge.relation}, ${String(edge.score)})` : person.name
    })
    .join(' → ')
}
