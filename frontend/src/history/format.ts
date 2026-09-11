// How the history shows who and where (Task 19). What changed arrives already worded by the backend formatter
// (backend/app/services/history.py); this module only names actors and sources and dates entries.
import type { AuditSource, HistoryActor } from '../api/history'

export const SOURCE_LABELS: Record<AuditSource, string> = {
  ui: 'Interface',
  import: 'Import',
  database_explorer: 'Base de données',
  cli: 'Ligne de commande',
  agent: 'Agent',
}

export interface ActorBadgeText {
  text: string
  tone: 'accent' | 'neutral'
}

// « Vous » for the signed-in person, the name of another person, « Import « base.xlsx » », « Système », « Agent ».
export function actorBadge(actor: HistoryActor, currentUserId: string | null): ActorBadgeText {
  switch (actor.kind) {
    case 'human':
      return actor.id !== null && actor.id === currentUserId
        ? { text: 'Vous', tone: 'accent' }
        : { text: actor.label, tone: 'neutral' }
    case 'import':
      return { text: `Import « ${actor.label} »`, tone: 'neutral' }
    case 'system':
      return { text: 'Système', tone: 'neutral' }
    case 'agent':
      return { text: 'Agent', tone: 'neutral' }
  }
}

// What follows the badge: the source, the command or agent's own label, and who confirmed an import.
export function actorDetails(actor: HistoryActor, source: AuditSource | null): string[] {
  const sourceLabel = source ? SOURCE_LABELS[source] : null
  const own = (actor.kind === 'system' || actor.kind === 'agent') && actor.label !== sourceLabel ? actor.label : null
  return [sourceLabel, own, actor.on_behalf_of ? `confirmé par ${actor.on_behalf_of}` : null].filter(
    (part): part is string => part !== null,
  )
}

// Home's one-line origin: the person (or agent) and, for a Database Explorer edit, where.
export function actorName(actor: HistoryActor): string {
  return actor.kind === 'agent' ? `Agent « ${actor.label} »` : actor.label
}

const MOMENT = new Intl.DateTimeFormat('fr-FR', {
  day: 'numeric',
  month: 'short',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  timeZone: 'Europe/Paris',
})
const RELATIVE = new Intl.RelativeTimeFormat('fr-FR', { numeric: 'auto' })
const STEPS: [Intl.RelativeTimeFormatUnit, number][] = [
  ['minute', 60],
  ['hour', 24],
  ['day', 30],
]

// « 11 sept. 2026 à 10:32 », in Circoe's time zone.
export function absoluteMoment(iso: string): string {
  return MOMENT.format(new Date(iso)).replace(', ', ' à ')
}

// « à l’instant », « il y a 5 minutes », « hier »… up to a month, then nothing (the absolute date says it). A moment
// slightly after `now` (clocks differ) is « à l’instant » too.
export function relativeMoment(iso: string, now: number): string | null {
  let amount = (now - new Date(iso).getTime()) / 60_000
  if (amount < 1) return 'à l’instant'
  for (const [unit, size] of STEPS) {
    if (amount < size) return RELATIVE.format(-Math.round(amount), unit)
    amount /= size
  }
  return null
}
