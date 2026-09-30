import type { MessageStatus } from '../api/contact'
import { Badge, StatusBadge } from '../ui/Badge'
import { MESSAGE_BADGES, MESSAGE_STATUS_LABELS } from './labels'

// A message's status (glyph + text, tones in labels.ts); a step never written reads « Vide », a plain tag.
export function MessageBadge({ status }: { status: MessageStatus | null }) {
  if (!status) return <Badge>Vide</Badge>
  const { tone, icon } = MESSAGE_BADGES[status]
  return (
    <StatusBadge tone={tone} icon={icon}>
      {MESSAGE_STATUS_LABELS[status]}
    </StatusBadge>
  )
}
