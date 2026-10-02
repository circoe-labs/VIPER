import type { TrackingStatus } from '../api/prospection'
import { Badge, StatusBadge, type StatusTone } from '../ui/Badge'
import {
  BanIcon,
  CalendarIcon,
  CheckCircleIcon,
  CheckIcon,
  ClockIcon,
  type IconComponent,
  MailIcon,
  MinusCircleIcon,
} from '../ui/icons'
import { formatDay, levelLabel, TRACKING_LABELS } from './labels'

// The Contact indicators of a person (sequences rework D5-D9), display only — no rule is decided here: the cohort
// (« validation métier »), the level reached by the real sends, the commercial state, and the flags that take a person
// out of the automatic actions. Tone mapping: doc/design/design-system.md (Contact badges). Every badge is glyph + text,
// with a hidden prefix naming what it is for screen readers.

type ShownState = Exclude<TrackingStatus, 'neutral'>

export const STATE_BADGES: Record<ShownState, { tone: StatusTone; icon: IconComponent }> = {
  // A reply waits for a human decision.
  response_received: { tone: 'info', icon: MailIcon },
  appointment_obtained: { tone: 'success', icon: CheckCircleIcon },
  // Terminal, reinforces « Ne pas contacter ».
  ignored: { tone: 'danger', icon: BanIcon },
  // A person's decision: to eliminate, out of the active pipeline (kept in the base).
  disqualified: { tone: 'danger', icon: MinusCircleIcon },
}

// The state badge; nothing for `neutral` (« En séquence ») or no tracking.
export function StateBadge({ status }: { status: TrackingStatus | null }) {
  if (!status || status === 'neutral') return null
  const { tone, icon } = STATE_BADGES[status]
  return (
    <StatusBadge tone={tone} icon={icon}>
      <span className="visually-hidden">État : </span>
      {TRACKING_LABELS[status]}
    </StatusBadge>
  )
}

interface CohortBadgeProps {
  // `S39`, `S0`; null: no cohort (not validated).
  code: string | null
  // The cohort's real start date, for the tooltip, when known.
  startsOn?: string | null
}

// The cohort `Sxx` — a prospecting session with its real date, never an ISO week. `S0`: validated, out of campaign.
export function CohortBadge({ code, startsOn = null }: CohortBadgeProps) {
  if (code === null) {
    return (
      <StatusBadge tone="neutral">
        <span className="visually-hidden">Validation : </span>
        Non validé
      </StatusBadge>
    )
  }
  if (code === 'S0') {
    return (
      <StatusBadge tone="neutral" icon={MinusCircleIcon}>
        <span className="visually-hidden">Cohorte : </span>
        S0 · hors campagne
      </StatusBadge>
    )
  }
  const title = startsOn ? `Cohorte ${code}, premier envoi le ${formatDay(startsOn)}` : `Cohorte ${code}`
  return (
    <Badge tone="accent" icon={CalendarIcon} title={title}>
      <span className="visually-hidden">Cohorte : </span>
      {code}
    </Badge>
  )
}

// The level reached by the real sends (`contact_pending`, `r2_sent`, `finished`…). « Relance terminée » is out of the
// automatic actions but still contactable: a neutral status, not a failure.
export function LevelBadge({ level }: { level: string | null }) {
  if (level === null) return null
  if (level === 'finished') {
    return (
      <StatusBadge tone="neutral" icon={CheckIcon}>
        <span className="visually-hidden">Niveau : </span>
        {levelLabel(level)}
      </StatusBadge>
    )
  }
  return (
    <Badge icon={MailIcon}>
      <span className="visually-hidden">Niveau : </span>
      {levelLabel(level)}
    </Badge>
  )
}

// An open « Erreur sur le mail » (a person's or an import's): out of the automatic actions until a new address and a
// new cohort.
export function EmailErrorBadge() {
  return (
    <StatusBadge tone="danger" icon={MailIcon}>
      Erreur sur le mail
    </StatusBadge>
  )
}

// The next step's due date has come (the `due` segment, « Échus »).
export function DueBadge() {
  return (
    <StatusBadge tone="warning" icon={ClockIcon}>
      Échu
    </StatusBadge>
  )
}
