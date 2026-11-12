import type { MissionResultStatus } from '../api/missions'
import type { StatusTone } from '../ui/Badge'

export const RESULT_STATUS_TONES: Record<MissionResultStatus, StatusTone> = {
  pending_review: 'warning',
  accepted: 'success',
  rejected: 'danger',
  superseded: 'neutral',
}

export function plural(count: number, one: string, many: string): string {
  return `${String(count)} ${count > 1 ? many : one}`
}
