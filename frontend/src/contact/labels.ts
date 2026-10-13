// French copy of the Contact page: the next step, the steps and
// statuses of the mail sequence, and date formats.
import type { MessageStatus, MessageStep } from '../api/contact'
import type { StatusTone } from '../ui/Badge'
import {
  CheckIcon,
  ClockIcon,
  CloseIcon,
  type IconComponent,
  MailIcon,
  PencilIcon,
} from '../ui/icons'

export const STEP_LABELS: Record<MessageStep, string> = { contact: 'Contact', r1: 'R1', r2: 'R2' }

// What the next action prepares, shown on the row.
export const NEXT_STEP_LABELS: Record<string, string> = {
  contact: 'Premier contact',
  r1: 'Relance R1',
  r2: 'Relance R2',
}

export const MESSAGE_STATUS_LABELS: Record<MessageStatus, string> = {
  draft: 'Brouillon',
  validated: 'Validé',
  scheduled: 'Programmé',
  sent: 'Envoyé',
  cancelled: 'Annulé',
}

// Glyph + tone of each message status (never colour alone): a draft is work in progress (neutral), a validated or
// scheduled message is confirmed by a person (info), a sent one is the positive end (success), a cancelled one is set
// aside (neutral, cross).
export const MESSAGE_BADGES: Record<MessageStatus, { tone: StatusTone; icon: IconComponent }> = {
  draft: { tone: 'neutral', icon: PencilIcon },
  validated: { tone: 'info', icon: CheckIcon },
  scheduled: { tone: 'info', icon: ClockIcon },
  sent: { tone: 'success', icon: MailIcon },
  cancelled: { tone: 'neutral', icon: CloseIcon },
}

const DATE_TIME = new Intl.DateTimeFormat('fr-FR', { dateStyle: 'full', timeStyle: 'short' })
const SHORT_DATE_TIME = new Intl.DateTimeFormat('fr-FR', { dateStyle: 'medium', timeStyle: 'short' })

// « mardi 6 octobre 2026 à 09:30 », in the browser's time zone (the one the operator picks the send moment in).
export function formatDateTime(iso: string): string {
  const date = new Date(iso)
  return Number.isNaN(date.getTime()) ? iso : DATE_TIME.format(date)
}

// « 6 oct. 2026, 09:30 »
export function formatShortDateTime(iso: string): string {
  const date = new Date(iso)
  return Number.isNaN(date.getTime()) ? iso : SHORT_DATE_TIME.format(date)
}
