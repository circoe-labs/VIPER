import type { WeekPoint } from '../api/metrics'

// Pure helpers of Home's week-by-week charts (no drawing): axis scale, labels and the honest conversion rates.

const SHORT_DAY = new Intl.DateTimeFormat('fr-FR', { day: 'numeric', month: 'short' })

// `2026-W43` -> `S43`.
export function shortWeek(label: string): string {
  const number = /-W(\d+)$/.exec(label)?.[1]
  return number ? `S${number}` : label
}

// `du 19 oct. au 25 oct.` (ISO dates, read as calendar days: no timezone shift).
export function weekRange(point: Pick<WeekPoint, 'week_start' | 'week_end'>): string {
  const day = (iso: string) => SHORT_DAY.format(new Date(`${iso}T12:00:00`))
  return `du ${day(point.week_start)} au ${day(point.week_end)}`
}

// Smallest 1/2/5 x 10^k at or above the biggest value, never below 4 so a quiet base does not stretch one bar.
export function niceMax(value: number): number {
  if (value <= 4) return 4
  const magnitude = 10 ** Math.floor(Math.log10(value))
  return [1, 2, 5, 10].map((step) => step * magnitude).find((candidate) => candidate >= value) ?? value
}

export function ratio(part: number, whole: number): number | undefined {
  return whole > 0 ? part / whole : undefined
}

const PERCENT = new Intl.NumberFormat('fr-FR', { style: 'percent', maximumFractionDigits: 1 })
export function percent(value: number | undefined): string {
  return value === undefined ? '–' : PERCENT.format(value)
}
