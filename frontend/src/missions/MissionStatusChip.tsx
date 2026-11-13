import type { MissionStatus } from '../api/missions'
import { StatusBadge } from '../ui/Badge'
import { MISSION_STATUS_ICONS, MISSION_STATUS_LABELS, MISSION_STATUS_TONES } from './labels'

// The one rendering of a mission's status (list card, detail header). Glyph + word + tone, from labels.ts, so the
// two surfaces cannot drift. Not an accent: status colour is semantic, the card accent is decoration.
export function MissionStatusChip({ status }: { status: MissionStatus }) {
  return (
    <StatusBadge tone={MISSION_STATUS_TONES[status]} icon={MISSION_STATUS_ICONS[status]}>
      {MISSION_STATUS_LABELS[status]}
    </StatusBadge>
  )
}
