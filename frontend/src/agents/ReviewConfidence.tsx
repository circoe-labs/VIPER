import { StatusBadge } from '../ui/Badge'
import { CONFIDENCE_BAND_LABELS, CONFIDENCE_BAND_TONES, confidenceBand } from './reviewFormat'

// Confidence as words + number + shape (never colour alone). `null`/`undefined` = the agent gave none (historical
// results carry no confidence on their items): said explicitly instead of showing 0 %.
// `compact` drops the « Confiance » prefix where a column header already says it (proposal table).
export function ConfidenceBadge({
  value,
  prefix = 'Confiance',
  compact = false,
}: {
  value: number | null | undefined
  prefix?: string
  compact?: boolean
}) {
  const band = confidenceBand(value)
  const label = band === 'unknown' ? 'non renseignée' : `${CONFIDENCE_BAND_LABELS[band].toLowerCase()} · ${String(Math.round(value as number))} %`
  const text = compact ? label.charAt(0).toUpperCase() + label.slice(1) : `${prefix} ${label}`
  return <StatusBadge tone={CONFIDENCE_BAND_TONES[band]}>{text}</StatusBadge>
}
