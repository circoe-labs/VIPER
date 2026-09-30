// French copy of the Contact page: the counters (doc/features/contact.md § Counters), the next step, the steps and
// statuses of the mail sequence, and date formats.
import type { ContactCounter, MessageStatus, MessageStep, NextStep } from '../api/contact'
import type { StatusTone } from '../ui/Badge'
import {
  CalendarIcon,
  CheckCircleIcon,
  CheckIcon,
  ClockIcon,
  CloseIcon,
  type IconComponent,
  MailIcon,
  PencilIcon,
  RefreshIcon,
} from '../ui/icons'

export interface CounterInfo {
  label: string
  // What the card counts, in one sentence (tooltip and list heading hint).
  hint: string
  icon: IconComponent
}

export const COUNTER_INFO: Record<ContactCounter, CounterInfo> = {
  to_handle: {
    label: 'À traiter cette semaine',
    hint: 'Premiers contacts, relances et revues R2 dont la semaine est arrivée ou dépassée (hors opposition et inactifs).',
    icon: CalendarIcon,
  },
  first_contact: {
    label: 'Premier contact',
    hint: 'Aucun état, semaine arrivée ou dépassée : le mail Contact à préparer.',
    icon: MailIcon,
  },
  follow_up: {
    label: 'Relances',
    hint: 'Contacté (R1 à préparer) ou R1 (R2 à préparer), semaine arrivée ou dépassée.',
    icon: RefreshIcon,
  },
  review: {
    label: 'Revues R2',
    hint: 'R2 envoyée, semaine de revue arrivée ou dépassée : décider de la suite (pas un nouveau mail).',
    icon: ClockIcon,
  },
  appointments: {
    label: 'RDV pris',
    hint: 'État « RDV pris », cumulé depuis le début (aucune fenêtre de temps).',
    icon: CheckCircleIcon,
  },
}

export const COUNTER_GROUPS: { id: string; title: string; counters: ContactCounter[] }[] = [
  { id: 'week', title: 'Cette semaine', counters: ['to_handle', 'first_contact', 'follow_up', 'review'] },
  { id: 'results', title: 'Résultats', counters: ['appointments'] },
]

export const STEP_LABELS: Record<MessageStep, string> = { contact: 'Contact', r1: 'R1', r2: 'R2' }

// What the next action prepares, shown on the row.
export const NEXT_STEP_LABELS: Record<NextStep, string> = {
  contact: 'Premier contact',
  r1: 'Relance R1',
  r2: 'Relance R2',
  review: 'Revue après R2',
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
