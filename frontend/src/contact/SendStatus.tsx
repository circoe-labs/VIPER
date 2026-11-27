import type { SendSituation } from '../api/unsent'
import { StatusBadge, type StatusTone } from '../ui/Badge'
import { AlertIcon, ClockIcon, type IconComponent, MinusCircleIcon } from '../ui/icons'
import { formatShortDateTime } from './labels'
import { sendReason } from './sendReason'
import './send-status.css'

interface Copy {
  badge: string
  tone: StatusTone
  icon: IconComponent
  // Before the date: « Contact programmé le … », « Contact prévu le … ».
  dated: string
}

function copyOf(send: SendSituation): Copy {
  switch (send.state) {
    case 'scheduled':
      return send.draft_missing
        ? { badge: 'Brouillon introuvable', tone: 'danger', icon: AlertIcon, dated: 'programmé le' }
        : { badge: 'Programmé', tone: 'info', icon: ClockIcon, dated: 'programmé le' }
    case 'unconfirmed':
      return { badge: 'Envoi à vérifier', tone: 'warning', icon: AlertIcon, dated: 'programmé le' }
    case 'doubt':
      return { badge: 'Peut-être parti', tone: 'warning', icon: AlertIcon, dated: 'prévu le' }
    case 'missed':
      return { badge: 'Non parti', tone: 'danger', icon: AlertIcon, dated: 'prévu le' }
    case 'unscheduled':
      return {
        badge: send.reason === 'cancelled' ? 'Annulé' : 'Déprogrammé',
        tone: 'neutral',
        icon: MinusCircleIcon,
        dated: 'prévu le',
      }
  }
}

export function SendBadge({ send }: { send: SendSituation }) {
  const copy = copyOf(send)
  return (
    <StatusBadge tone={copy.tone} icon={copy.icon}>
      {copy.badge}
    </StatusBadge>
  )
}

// The effective schedule of a prospect's send, or why it did not leave: which moment, why, and when it was noticed.
// Never the theoretical due date, which each list names apart (« échéance »).
export function SendLines({ send }: { send: SendSituation }) {
  const copy = copyOf(send)
  const explained = send.state !== 'scheduled'
  return (
    <span className={`send-lines send-lines--${send.state}`}>
      <span>
        {send.step_label} {copy.dated}{' '}
        {send.scheduled_at ? <time dateTime={send.scheduled_at}>{formatShortDateTime(send.scheduled_at)}</time> : '—'}
      </span>
      {explained && send.reason && (
        <span className="send-lines__why">
          {sendReason(send.reason)}
          {send.at && ` (le ${formatShortDateTime(send.at)})`}
        </span>
      )}
    </span>
  )
}
