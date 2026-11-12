import type { ActivityEventType, AgentSession, SessionDisconnectReason } from '../api/missions'
import type { StatusTone } from '../ui/Badge'
import { relativeMomentLabel } from './labels'

// Wording for the Activité tab. Factual vocabulary only: what the agent did, found or checked (never its reasoning).

export const EVENT_TYPE_LABELS: Record<ActivityEventType, string> = {
  search: 'Recherche',
  source_opened: 'Source ouverte',
  observation: 'Constat',
  verification: 'Vérification',
  progress: 'Avancement',
  warning: 'Alerte',
  error: 'Erreur',
  decision_summary: 'Bilan',
}

export const EVENT_TYPE_TONES: Record<ActivityEventType, StatusTone> = {
  search: 'neutral',
  source_opened: 'info',
  observation: 'neutral',
  verification: 'success',
  progress: 'info',
  warning: 'warning',
  error: 'danger',
  decision_summary: 'info',
}

export const SESSION_STATUS_LABELS: Record<AgentSession['status'], string> = {
  active: 'En cours',
  ended: 'Terminée',
  timed_out: 'Expirée',
}

export const SESSION_STATUS_TONES: Record<AgentSession['status'], StatusTone> = {
  active: 'success',
  ended: 'neutral',
  timed_out: 'warning',
}

export const DISCONNECT_REASON_LABELS: Record<SessionDisconnectReason, string> = {
  agent_ended: 'Clôturée par l’agent',
  run_finished: 'Exécution terminée',
  mission_cancelled: 'Mission annulée',
  inactivity_timeout: 'Aucune activité pendant 3 h',
}

export function sessionLabel(session: Pick<AgentSession, 'agent_label' | 'started_at'>, now: number): string {
  return `${session.agent_label} · démarrée ${relativeMomentLabel(session.started_at, now) ?? ''}`.trim()
}

export function logsCountLabel(count: number): string {
  return count === 0 ? 'Aucune entrée' : `${String(count)} entrée${count > 1 ? 's' : ''}`
}

// Only http(s) sources become links (a stored `javascript:` URL must never be clickable).
export function safeSourceUrl(value: string | null): URL | null {
  if (!value) return null
  try {
    const url = new URL(value)
    return url.protocol === 'http:' || url.protocol === 'https:' ? url : null
  } catch {
    return null
  }
}

// The source's own stated date, as given: a bare date stays a date (UTC), never shifted by the viewer's zone.
export function sourceDateLabel(value: string | null): string | null {
  if (!value) return null
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return null
  const bare = value.length === 10
  return date.toLocaleDateString('fr-FR', {
    dateStyle: 'long',
    ...(bare ? { timeZone: 'UTC' } : {}),
  })
}

export function absoluteMomentLabel(value: string): string {
  const date = new Date(value)
  return Number.isNaN(date.getTime())
    ? value
    : date.toLocaleString('fr-FR', {
        dateStyle: 'medium',
        timeStyle: 'medium',
      })
}
