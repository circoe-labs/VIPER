import { isoWeekOf, weekBadgeLabel } from '../lib/isoWeek'

const PARIS_DAY = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Paris' })

// A next action is a week, not a moment (Contact decision 5): `2026-09-07T22:00:00Z` → « Semaine S37 » (the business
// day in Europe/Paris decides the week). Null without a moment.
export function weekOfMoment(iso: string | null): string | null {
  if (!iso) return null
  const week = isoWeekOf(PARIS_DAY.format(new Date(iso)))
  return week ? `Semaine ${weekBadgeLabel(week)}` : null
}
