import type { MissionResultStatus } from '../api/missions'
import type { StatusTone } from '../ui/Badge'

// French vocabulary of a result in the review queue (Results tab).
export const RESULT_STATUS_LABELS: Record<MissionResultStatus, string> = {
  pending_review: 'À relire',
  accepted: 'Validé',
  rejected: 'Rejeté',
  superseded: 'Remplacé',
}

export const RESULT_STATUS_TONES: Record<MissionResultStatus, StatusTone> = {
  pending_review: 'warning',
  accepted: 'success',
  rejected: 'danger',
  superseded: 'neutral',
}

export function plural(count: number, one: string, many: string): string {
  return `${String(count)} ${count > 1 ? many : one}`
}
