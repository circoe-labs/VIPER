import type { StatusTone } from '../ui/Badge'
import { BanIcon, CheckCircleIcon, type IconComponent, PauseIcon, PlayIcon } from '../ui/icons'
import type {
  MissionCard,
  MissionResultKind,
  MissionRunStatus,
  MissionStatus,
  MissionType,
  RecurrenceUnit,
} from '../api/missions'

// French vocabulary of a mission. The task labels stay in agents/labels.ts: the detail page reuses
// them so a task reads the same in a mission and in a legacy thread.

export const MISSION_TYPE_LABELS: Record<MissionType, string> = {
  prospection: 'Prospection ciblée',
  signals: 'Recherche de signaux',
  enrichment: 'Enrichissement',
  verification: 'Vérification',
  other: 'Autre',
}

export const MISSION_STATUS_LABELS: Record<MissionStatus, string> = {
  active: 'Active',
  paused: 'Inactive',
  done: 'Terminée',
  cancelled: 'Annulée',
}

export const MISSION_STATUS_TONES: Record<MissionStatus, StatusTone> = {
  active: 'info',
  paused: 'warning',
  done: 'success',
  cancelled: 'neutral',
}

// A mission's state reads as a shape too: running (play), paused, done, cancelled.
export const MISSION_STATUS_ICONS: Record<MissionStatus, IconComponent> = {
  active: PlayIcon,
  paused: PauseIcon,
  done: CheckCircleIcon,
  cancelled: BanIcon,
}

export const RUN_STATUS_LABELS: Record<MissionRunStatus, string> = {
  scheduled: 'Programmée',
  running: 'En cours',
  done: 'Terminée',
  failed: 'Échec',
  cancelled: 'Annulée',
}

export const RUN_STATUS_TONES: Record<MissionRunStatus, StatusTone> = {
  scheduled: 'neutral',
  running: 'info',
  done: 'success',
  failed: 'danger',
  cancelled: 'neutral',
}

export const RESULT_KIND_LABELS: Record<MissionResultKind, string> = {
  companies: 'Sociétés',
  prospects: 'Prospects',
  signals: 'Signaux',
  enrichment: 'Informations complétant les fiches',
}

export const UNIT_LABELS: Record<RecurrenceUnit, string> = {
  hours: 'heures',
  days: 'jours',
  weeks: 'semaines',
  months: 'mois',
}

export function recurrenceLabel(card: Pick<MissionCard, 'is_recurring' | 'interval_count' | 'interval_unit'>): string {
  if (!card.is_recurring) return 'Ponctuelle'
  const unit = UNIT_LABELS[card.interval_unit]
  return `Toutes les ${String(card.interval_count)} ${unit}`
}

const dateFormat = new Intl.DateTimeFormat('fr-FR', { dateStyle: 'medium', timeStyle: 'short' })

export function momentLabel(value: string | null): string | null {
  if (!value) return null
  return dateFormat.format(new Date(value))
}

export function shortMomentLabel(value: string | null): string | null {
  if (!value) return null
  return new Intl.DateTimeFormat('fr-FR', { dateStyle: 'short', timeStyle: 'short' }).format(new Date(value))
}
