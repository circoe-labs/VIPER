// ISO 8601 weeks on business days (`YYYY-MM-DD`, Europe/Paris), for the next-action week of the Contact states.
// Mirror of backend/app/services/contact_workflow.py (`IsoWeek`, `weeks_in_year`): the backend stores a week as its
// Monday (Contact port decision P1) and sends `planned_contact_week` as `2026-W41`. Pure calendar arithmetic, in UTC
// so the browser's zone never shifts a day.

export interface IsoWeek {
  // ISO week-numbering year (the Thursday's year: 2026-12-31 is in 2026-W53, 2027-01-04 in 2027-W01).
  year: number
  week: number
}

const DAY_MS = 86_400_000

function utc(day: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day)
  if (!match) return null
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])))
  return Number.isNaN(date.getTime()) ? null : date
}

function dayOf(date: Date): string {
  return date.toISOString().slice(0, 10)
}

// Today in Circoe's business time zone (`YYYY-MM-DD`), when the server has not given its business day.
export function businessToday(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Paris' }).format(new Date())
}

// ISO week of a `YYYY-MM-DD` day; null when the day is not one.
export function isoWeekOf(day: string): IsoWeek | null {
  const date = utc(day)
  if (!date) return null
  // The Thursday of the same week decides the year.
  date.setUTCDate(date.getUTCDate() + 4 - (date.getUTCDay() || 7))
  const year = date.getUTCFullYear()
  const week = Math.ceil(((date.getTime() - Date.UTC(year, 0, 1)) / DAY_MS + 1) / 7)
  return { year, week }
}

// `2026-W41` (the API's `planned_contact_week` / `suggested_next_contact_week`) → week; null when malformed.
export function parseIsoWeek(label: string | null | undefined): IsoWeek | null {
  const match = /^(\d{4})-W(\d{2})$/.exec(label ?? '')
  if (!match) return null
  const week = { year: Number(match[1]), week: Number(match[2]) }
  return week.week >= 1 && week.week <= weeksInYear(week.year) ? week : null
}

// 52 or 53: December 28 always falls in the last ISO week of its year.
export function weeksInYear(year: number): number {
  return isoWeekOf(`${String(year).padStart(4, '0')}-12-28`)?.week ?? 52
}

// The Monday of `week`, `YYYY-MM-DD` — what the planner writes (P1).
export function weekMonday({ year, week }: IsoWeek): string {
  const january4 = new Date(Date.UTC(year, 0, 4))
  const monday = january4.getTime() - ((january4.getUTCDay() || 7) - 1) * DAY_MS
  return dayOf(new Date(monday + (week - 1) * 7 * DAY_MS))
}

export function addWeeks(week: IsoWeek, count: number): IsoWeek {
  const monday = utc(weekMonday(week)) as Date
  return isoWeekOf(dayOf(new Date(monday.getTime() + count * 7 * DAY_MS))) as IsoWeek
}

// Whole weeks from the week of `today` to `week` (negative when past).
export function weeksFrom(today: string, week: IsoWeek): number {
  const current = isoWeekOf(today)
  if (!current) return 0
  const from = utc(weekMonday(current)) as Date
  const to = utc(weekMonday(week)) as Date
  return Math.round((to.getTime() - from.getTime()) / (7 * DAY_MS))
}

export function sameWeek(a: IsoWeek | null, b: IsoWeek | null): boolean {
  return a === null || b === null ? a === b : a.year === b.year && a.week === b.week
}

// « S41 » (two digits, like the backend label).
export function weekBadgeLabel({ week }: IsoWeek): string {
  return `S${String(week).padStart(2, '0')}`
}

const MONDAY = new Intl.DateTimeFormat('fr-FR', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' })

// « lun. 5 oct. »
export function mondayLabel(week: IsoWeek): string {
  return MONDAY.format(utc(weekMonday(week)) as Date)
}

// « cette semaine », « dans 2 semaines », « il y a 1 semaine ».
export function relativeWeekLabel(today: string, week: IsoWeek): string {
  const count = weeksFrom(today, week)
  if (count === 0) return 'cette semaine'
  const text = `${String(Math.abs(count))} semaine${Math.abs(count) > 1 ? 's' : ''}`
  return count > 0 ? `dans ${text}` : `il y a ${text}`
}
