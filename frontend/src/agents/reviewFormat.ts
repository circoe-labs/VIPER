import type { StatusTone } from '../ui/Badge'
import type { ScoreRingTone } from '../ui/ScoreRing'

// Display rules shared by the review dialog and the mission result cards (Slice 08). Confidence is the agent's own
// estimate (0-100) and is only ever shown as such; the bands below are presentation, not a validation rule.

export type ConfidenceBand = 'high' | 'medium' | 'low' | 'unknown'

export function confidenceBand(value: number | null | undefined): ConfidenceBand {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 'unknown'
  if (value >= 80) return 'high'
  if (value >= 50) return 'medium'
  return 'low'
}

export const CONFIDENCE_BAND_LABELS: Record<ConfidenceBand, string> = {
  high: 'Élevée',
  medium: 'Moyenne',
  low: 'Faible',
  unknown: 'Non renseignée',
}

export const CONFIDENCE_BAND_TONES: Record<ConfidenceBand, StatusTone> = {
  high: 'success',
  medium: 'warning',
  low: 'danger',
  unknown: 'neutral',
}

export const CONFIDENCE_RING_TONES: Record<ConfidenceBand, ScoreRingTone> = {
  high: 'success',
  medium: 'warning',
  low: 'danger',
  unknown: 'neutral',
}

const DAY_MS = 86_400_000

function parseDate(value: string): Date | null {
  // A bare date is read as a local calendar day so it never slides to the day before in a western timezone.
  const moment = new Date(/^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T00:00:00` : value)
  return Number.isNaN(moment.getTime()) ? null : moment
}

// « 12 sept. 2026 » (+ « 14:05 » for a datetime when `withTime`); an unreadable value is shown as received.
export function formatSourceDate(value: string, withTime = false): string {
  const moment = parseDate(value)
  if (!moment) return value
  const timed = withTime && value.length > 10
  return new Intl.DateTimeFormat('fr-FR', timed ? { dateStyle: 'medium', timeStyle: 'short' } : { dateStyle: 'medium' }).format(moment)
}

// A source published more than a year ago is flagged so a reviewer does not take it for fresh evidence.
export function isOldSource(published: string | null | undefined, now: number = Date.now()): boolean {
  if (!published) return false
  const moment = parseDate(published)
  return moment !== null && now - moment.getTime() > 365 * DAY_MS
}

export function sourceHost(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return url
  }
}

// Only web links are rendered as links: a source is agent-supplied text.
export function safeHref(url: string | null | undefined): string | null {
  if (!url) return null
  try {
    const parsed = new URL(url)
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.href : null
  } catch {
    return null
  }
}
