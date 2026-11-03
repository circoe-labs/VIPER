import type { StatusTone } from '../ui/Badge'
import type { TaskStatus, TaskType, ThreadStatus } from '../api/agents'

// French labels and tones of the mission vocabulary. Kept apart from the page so the list, the thread and the
// future review card say the same thing.

export const TASK_TYPE_LABELS: Record<TaskType, string> = {
  update_company: 'Mettre à jour la société',
  update_employee: 'Compléter un employé',
  find_employees: 'Trouver de nouveaux contacts',
  surveil_signals: 'Surveiller les signaux',
  find_prospects: 'Trouver de nouveaux prospects',
}

export const TASK_STATUS_LABELS: Record<TaskStatus, string> = {
  pending: 'En attente',
  claimed: 'En cours',
  submitted: 'À relire',
  accepted: 'Validée',
  failed: 'Échec',
  cancelled: 'Annulée',
}

export const TASK_STATUS_TONES: Record<TaskStatus, StatusTone> = {
  pending: 'neutral',
  claimed: 'info',
  submitted: 'warning',
  accepted: 'success',
  failed: 'danger',
  cancelled: 'neutral',
}

export const THREAD_STATUS_LABELS: Record<ThreadStatus, string> = {
  open: 'Ouverte',
  paused: 'En pause',
  done: 'Terminée',
  cancelled: 'Annulée',
}

export const THREAD_STATUS_TONES: Record<ThreadStatus, StatusTone> = {
  open: 'info',
  paused: 'warning',
  done: 'success',
  cancelled: 'neutral',
}

// « il y a 3 min », « hier à 14:05 » : enough to read a queue without a date library.
export function sinceLabel(value: string | null): string | null {
  if (!value) return null
  const moment = new Date(value)
  const minutes = Math.round((Date.now() - moment.getTime()) / 60_000)
  if (minutes < 1) return "à l’instant"
  if (minutes < 60) return `il y a ${String(minutes)} min`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `il y a ${String(hours)} h`
  return new Intl.DateTimeFormat('fr-FR', { dateStyle: 'short', timeStyle: 'short' }).format(moment)
}


// Signal kinds, as the review card and the company page show them.
export const SIGNAL_KIND_LABELS: Record<string, string> = {
  hiring: 'Recrutement',
  funding: 'Financement',
  news: 'Actualité',
  social_post: 'Publication',
  event: 'Événement',
  product_launch: 'Lancement produit',
  partnership: 'Partenariat',
  tech_change: 'Changement technique',
  need_expressed: 'Besoin exprimé',
  facility_opening: 'Ouverture de site',
  facility_expansion: 'Extension de site',
  construction: 'Construction',
  relocation: 'Déménagement',
  other: 'Autre',
}
