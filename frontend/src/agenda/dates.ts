// Calendar arithmetic of the Agenda. The business zone is Europe/Paris: a day is a `YYYY-MM-DD` key read in that zone,
// whatever the browser's. Pure calendar dates (no time of day) are computed in UTC so no daylight-saving shift can
// move them.

const ZONE = 'Europe/Paris'

const PARTS = new Intl.DateTimeFormat('en-GB', {
  timeZone: ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
})

export interface ParisParts {
  year: number
  month: number
  day: number
  hour: number
  minute: number
}

export function parisParts(moment: Date | string): ParisParts {
  const found: Record<string, number> = {}
  for (const part of PARTS.formatToParts(typeof moment === 'string' ? new Date(moment) : moment)) {
    if (part.type !== 'literal') found[part.type] = Number(part.value)
  }
  return {
    year: found.year ?? 0,
    month: found.month ?? 0,
    day: found.day ?? 0,
    hour: found.hour ?? 0,
    minute: found.minute ?? 0,
  }
}

const pad = (value: number) => String(value).padStart(2, '0')

// The business day of a moment, as `YYYY-MM-DD`.
export function dayKey(moment: Date | string): string {
  const { year, month, day } = parisParts(moment)
  return `${String(year)}-${pad(month)}-${pad(day)}`
}

export function todayKey(): string {
  return dayKey(new Date())
}

// `HH:mm` in Paris.
export function timeOf(moment: Date | string): string {
  const { hour, minute } = parisParts(moment)
  return `${pad(hour)}:${pad(minute)}`
}

function asDate(key: string): Date {
  const [year = 1970, month = 1, day = 1] = key.split('-').map(Number)
  return new Date(Date.UTC(year, month - 1, day))
}

function asKey(date: Date): string {
  return `${String(date.getUTCFullYear())}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`
}

export function addDays(key: string, days: number): string {
  const date = asDate(key)
  date.setUTCDate(date.getUTCDate() + days)
  return asKey(date)
}

export function addMonths(key: string, months: number): string {
  const date = asDate(key)
  date.setUTCDate(1)
  date.setUTCMonth(date.getUTCMonth() + months)
  return asKey(date)
}

// Monday = 0 … Sunday = 6.
export function weekdayIndex(key: string): number {
  return (asDate(key).getUTCDay() + 6) % 7
}

export function startOfWeek(key: string): string {
  return addDays(key, -weekdayIndex(key))
}

export function startOfMonth(key: string): string {
  return `${key.slice(0, 7)}-01`
}

export function sameMonth(a: string, b: string): boolean {
  return a.slice(0, 7) === b.slice(0, 7)
}

export type AgendaView = 'month' | 'week'

// The days shown for `anchor`: the weeks (Monday first) that cover its month, or its own week.
export function visibleDays(anchor: string, view: AgendaView): string[] {
  if (view === 'week') {
    const start = startOfWeek(anchor)
    return Array.from({ length: 7 }, (_, index) => addDays(start, index))
  }
  const first = startOfMonth(anchor)
  const start = startOfWeek(first)
  const last = addDays(addMonths(first, 1), -1)
  const weeks = Math.ceil((weekdayIndex(first) + Number(last.slice(8))) / 7)
  return Array.from({ length: weeks * 7 }, (_, index) => addDays(start, index))
}

export function stepAnchor(anchor: string, view: AgendaView, direction: 1 | -1): string {
  return view === 'week' ? addDays(anchor, 7 * direction) : addMonths(anchor, direction)
}

const MONTH_TITLE = new Intl.DateTimeFormat('fr-FR', { month: 'long', year: 'numeric', timeZone: 'UTC' })
const DAY_SHORT = new Intl.DateTimeFormat('fr-FR', { day: 'numeric', month: 'short', timeZone: 'UTC' })
const DAY_LONG = new Intl.DateTimeFormat('fr-FR', {
  weekday: 'long',
  day: 'numeric',
  month: 'long',
  timeZone: 'UTC',
})
const DAY_FULL = new Intl.DateTimeFormat('fr-FR', {
  weekday: 'long',
  day: 'numeric',
  month: 'long',
  year: 'numeric',
  timeZone: 'UTC',
})
const WEEKDAY_SHORT = new Intl.DateTimeFormat('fr-FR', { weekday: 'short', timeZone: 'UTC' })

export function periodTitle(anchor: string, view: AgendaView): string {
  if (view === 'month') return MONTH_TITLE.format(asDate(anchor))
  const start = startOfWeek(anchor)
  const end = addDays(start, 6)
  return `${DAY_SHORT.format(asDate(start))} – ${DAY_SHORT.format(asDate(end))} ${end.slice(0, 4)}`
}

export const dayLong = (key: string) => DAY_LONG.format(asDate(key))
export const dayFull = (key: string) => DAY_FULL.format(asDate(key))
export const weekdayShort = (key: string) => WEEKDAY_SHORT.format(asDate(key))
export const dayNumber = (key: string) => String(Number(key.slice(8)))

// An instant from a Paris wall-clock day and time (`YYYY-MM-DD`, `HH:mm`), as an ISO string. The zone's offset at that
// moment is found by reading a first guess back in Paris.
export function parisInstant(day: string, time: string): string {
  const [year = 1970, month = 1, dayOfMonth = 1] = day.split('-').map(Number)
  const [hour = 0, minute = 0] = time.split(':').map(Number)
  const wanted = Date.UTC(year, month - 1, dayOfMonth, hour, minute)
  const seen = parisParts(new Date(wanted))
  const shown = Date.UTC(seen.year, seen.month - 1, seen.day, seen.hour, seen.minute)
  return new Date(wanted - (shown - wanted)).toISOString()
}

export function minutesBetween(from: string, to: string): number {
  return Math.round((new Date(to).getTime() - new Date(from).getTime()) / 60000)
}

export function addMinutes(moment: string, minutes: number): string {
  return new Date(new Date(moment).getTime() + minutes * 60000).toISOString()
}

const SENT_ON = new Intl.DateTimeFormat('fr-FR', {
  day: 'numeric',
  month: 'long',
  timeZone: ZONE,
})
export const formatSentOn = (moment: string) => SENT_ON.format(new Date(moment))
