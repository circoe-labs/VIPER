// French copy of the Prospection workspace: the segment catalogue (counters, also for Home — Task 16), state labels
// and date formats. Segment meanings: doc/features/prospection-kpis.md.
import type { ActivityStatus, ProspectRow, ProspectSort, Segment, TrackingStatus } from '../api/prospection'
import {
  AlertIcon,
  BanIcon,
  CheckCircleIcon,
  ClockIcon,
  type IconComponent,
  InfoIcon,
  MinusCircleIcon,
  UsersIcon,
} from '../ui/icons'

export interface SegmentInfo {
  label: string
  // What the counter counts, in one sentence (tooltip and list heading hint).
  hint: string
  icon: IconComponent
}

export const SEGMENT_INFO: Record<Segment, SegmentInfo> = {
  all: { label: 'Tous', hint: 'Toutes les personnes de la base.', icon: UsersIcon },
  active: { label: 'Actifs', hint: 'Activité « Actif » : en poste.', icon: CheckCircleIcon },
  unknown: { label: 'Inconnus', hint: 'Activité « Inconnue » : pas encore déterminée.', icon: InfoIcon },
  inactive: { label: 'Inactifs', hint: 'Activité « Inactif » : plus en poste.', icon: MinusCircleIcon },
  do_not_contact: {
    label: 'Opposition',
    hint: 'Ne pas contacter : opposition durable, exclue des contacts à faire.',
    icon: BanIcon,
  },
  never_verified: {
    label: 'Jamais vérifiés',
    hint: 'Aucune date de vérification de l’emploi actuel (entreprise, rôle, activité).',
    icon: AlertIcon,
  },
  needs_recheck: {
    label: 'À revérifier',
    hint: 'Emploi vérifié, mais une coordonnée vérifiée a été remise à vérifier (changement d’entreprise).',
    icon: ClockIcon,
  },
  email_missing: { label: 'E-mail manquant', hint: 'Aucune adresse e-mail principale.', icon: AlertIcon },
  email_invalid: { label: 'E-mail invalide', hint: 'L’adresse e-mail principale est invalide.', icon: BanIcon },
  email_unverified: {
    label: 'E-mail non vérifié',
    hint: 'L’adresse e-mail principale n’est pas vérifiée.',
    icon: AlertIcon,
  },
  to_contact: {
    label: 'À contacter',
    hint: 'Dans une cohorte de campagne, Contact pas encore envoyé (hors S0, opposition, inactifs et erreur sur le mail).',
    icon: UsersIcon,
  },
  due: {
    label: 'Échus',
    hint: 'Contact ou relance à envoyer, échéance arrivée ou dépassée (hors opposition et inactifs).',
    icon: ClockIcon,
  },
  contacted: {
    label: 'Contactés',
    hint: 'Au moins un e-mail réellement envoyé (toutes séquences), ou une réponse ou un RDV enregistré.',
    icon: CheckCircleIcon,
  },
  no_response: {
    label: 'Sans réponse',
    hint: 'En séquence, au moins un envoi, ni réponse ni RDV, relances pas terminées (hors opposition et inactifs).',
    icon: MinusCircleIcon,
  },
  responses: {
    label: 'Réponses',
    hint: 'Réponse reçue ou RDV pris, ou une date de réponse ou de rendez-vous enregistrée.',
    icon: CheckCircleIcon,
  },
  appointments: { label: 'Rendez-vous', hint: 'RDV pris, ou une date de rendez-vous enregistrée.', icon: CheckCircleIcon },
}

export const SEGMENT_GROUPS: { id: 'base' | 'verification' | 'contact'; title: string; segments: Segment[] }[] = [
  { id: 'base', title: 'Base', segments: ['all', 'active', 'unknown', 'inactive', 'do_not_contact'] },
  {
    id: 'verification',
    title: 'Vérification',
    segments: ['never_verified', 'needs_recheck', 'email_missing', 'email_invalid', 'email_unverified'],
  },
  {
    id: 'contact',
    title: 'Suivi de contact',
    segments: ['to_contact', 'due', 'contacted', 'no_response', 'responses', 'appointments'],
  },
]

// Commercial state labels (backend contact_workflow.STATE_LABELS). `neutral` (« En séquence ») has no badge in the
// lists; it is named where a state must be (select option, filter, history, export).
export const TRACKING_LABELS: Record<TrackingStatus, string> = {
  neutral: 'En séquence',
  response_received: 'Réponse reçue',
  appointment_obtained: 'RDV pris',
  ignored: 'Ignoré',
  disqualified: 'Défaillant',
}

// The label shown beside a person (lists, Home): none for `neutral` or no tracking.
export function stateLabel(status: TrackingStatus | null): string | null {
  return status && status !== 'neutral' ? TRACKING_LABELS[status] : null
}

const SENT_LEVEL = /^r([1-9]\d?)_sent$/

// The level of a sequence from its key (backend contact_steps.level_key): what was really sent. One wording for every
// screen, whatever `level_label` the API also gives (the lists' « R2 envoyée », the sheet's next step « R3 »).
export function levelLabel(level: string): string {
  if (level === 'contact_pending') return 'Contact à envoyer'
  if (level === 'contact_sent') return 'Contact envoyé'
  if (level === 'finished') return 'Relance terminée'
  const rank = SENT_LEVEL.exec(level)?.[1]
  return rank ? `R${rank} envoyée` : level
}

// « Contact », « R2 »: the step to send next from its code (`contact`, `r2`).
export function stepLabel(step: string): string {
  return step === 'contact' ? 'Contact' : step.toUpperCase()
}

// D12: a missing function, e-mail or phone (without another channel) is shown « À vérifier » — never stored.
export const TO_VERIFY = 'À vérifier'

export const ACTIVITY_LABELS: Record<ActivityStatus, string> = {
  active: 'Actif',
  unknown: 'Activité inconnue',
  inactive: 'Inactif',
}

export const SORT_LABELS: Record<ProspectSort, string> = {
  name: 'Nom',
  company: 'Entreprise',
  next_due: 'Prochaine échéance la plus proche',
  verification: 'Vérification la plus ancienne',
  updated: 'Modifiés récemment',
}

const DAY = new Intl.DateTimeFormat('fr-FR', {
  day: 'numeric',
  month: 'short',
  year: 'numeric',
  timeZone: 'Europe/Paris',
})

// e.g. « 14 sept. 2026 », in Circoe's time zone like the backend's business day.
export function formatDay(iso: string): string {
  return DAY.format(new Date(iso))
}

export function personName(row: Pick<ProspectRow, 'first_name' | 'last_name'>): string {
  return [row.first_name, row.last_name].filter(Boolean).join(' ')
}

export function civilityLabel(civility: ProspectRow['civility']): string | null {
  if (civility === 'mr') return 'M.'
  return civility === 'ms' ? 'Mme' : null
}

// Stored `+33612345678` → « +33 6 12 34 56 78 »; other numbers as stored.
export function formatPhone(number: string): string {
  const french = /^\+33(\d)(\d{2})(\d{2})(\d{2})(\d{2})$/.exec(number)
  return french ? `+33 ${french.slice(1).join(' ')}` : number
}
