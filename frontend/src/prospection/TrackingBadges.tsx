import type { TrackingStatus } from '../api/prospection'
import { isoWeekOf, type IsoWeek, mondayLabel, weekBadgeLabel } from '../lib/isoWeek'
import { Badge, StatusBadge, type StatusTone } from '../ui/Badge'
import {
  BanIcon,
  CalendarIcon,
  CheckCircleIcon,
  CheckIcon,
  type IconComponent,
  MailIcon,
  MinusCircleIcon,
  RefreshIcon,
} from '../ui/icons'
import { TRACKING_LABELS } from './labels'

// The two independent Contact indicators (Contact decisions 4-5): the state and the next-action week. Display only —
// no workflow rule is decided here. Tone mapping: doc/design/design-system.md (Contact state badges).

type ShownState = Exclude<TrackingStatus, 'neutral'>

export const STATE_BADGES: Record<ShownState, { tone: StatusTone; icon: IconComponent }> = {
  // The sequence in progress: nothing to signal beyond the step reached.
  contacted: { tone: 'neutral', icon: CheckIcon },
  r1: { tone: 'neutral', icon: RefreshIcon },
  r2: { tone: 'neutral', icon: RefreshIcon },
  // A reply waits for a human decision (RDV pris, Failure…).
  response_received: { tone: 'info', icon: MailIcon },
  appointment_obtained: { tone: 'success', icon: CheckCircleIcon },
  // Closed without outcome: not an opposition.
  failure: { tone: 'neutral', icon: MinusCircleIcon },
  // Terminal, reinforces « Ne pas contacter ».
  ignored: { tone: 'danger', icon: BanIcon },
}

// The state badge; nothing for `neutral` or no tracking (decision 4).
export function StateBadge({ status }: { status: TrackingStatus | null }) {
  if (!status || status === 'neutral') return null
  const { tone, icon } = STATE_BADGES[status]
  return (
    <StatusBadge tone={tone} icon={icon} strong={status === 'response_received' || status === 'appointment_obtained'}>
      <span className="visually-hidden">État : </span>
      {TRACKING_LABELS[status]}
    </StatusBadge>
  )
}

// « Semaine 41 de 2026, du lun. 5 oct. »
export function weekTitle(week: IsoWeek): string {
  return `Semaine ${String(week.week)} de ${String(week.year)}, du ${mondayLabel(week)}`
}

// The next-action week, « S41 »; its year is written out when it is not the current one (« S02 · 2027 »), and is
// always in the tooltip and for screen readers.
export function WeekBadge({ week, today }: { week: IsoWeek; today: string }) {
  const otherYear = isoWeekOf(today)?.year !== week.year
  const title = weekTitle(week)
  return (
    <Badge tone="accent" icon={CalendarIcon} title={title}>
      <span className="visually-hidden">Prochaine action : {title}</span>
      <span aria-hidden="true">
        {weekBadgeLabel(week)}
        {otherYear && ` · ${String(week.year)}`}
      </span>
    </Badge>
  )
}
