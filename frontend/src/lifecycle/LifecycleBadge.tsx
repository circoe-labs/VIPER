import type { Block, DepartureReason } from '../api/lifecycle'
import { StatusBadge } from '../ui/Badge'
import { ArchiveIcon, BanIcon, BriefcaseIcon, PauseIcon } from '../ui/icons'
import { BLOCK_LABELS, DEPARTURE_LABELS } from './model'

// Why someone (or a company) is out of prospecting, as one badge. The opposition keeps its own, louder badge: lists
// that already show it pass `hideOpposition`.
export function LifecycleBadge({ block, departure, hideOpposition = false }: { block: Block | null | undefined; departure?: DepartureReason | null; hideOpposition?: boolean }) {
  if (!block || (hideOpposition && block === 'prospect_do_not_contact')) return null
  const label = block === 'prospect_departed' && departure ? DEPARTURE_LABELS[departure] : BLOCK_LABELS[block]
  const icon = block === 'prospect_do_not_contact' ? BanIcon : block === 'prospect_departed' ? BriefcaseIcon : block.endsWith('archived') ? ArchiveIcon : PauseIcon
  return (
    <StatusBadge tone={block === 'prospect_do_not_contact' ? 'danger' : block.endsWith('archived') ? 'neutral' : 'warning'} icon={icon}>
      {label}
    </StatusBadge>
  )
}
