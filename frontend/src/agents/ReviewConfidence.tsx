import { StatusBadge } from '../ui/Badge'
import { CONFIDENCE_BAND_LABELS, CONFIDENCE_BAND_TONES, confidenceBand } from './reviewFormat'

// Confidence as words + number + shape (never colour alone). `null`/`undefined` = the agent gave none (historical
// results carry no confidence on their items): said explicitly instead of showing 0 %.
export function ConfidenceBadge({ value, prefix = 'Confiance' }: { value: number | null | undefined; prefix?: string }) {
  const band = confidenceBand(value)
  const text =
    band === 'unknown' ? `${prefix} non renseignée` : `${prefix} ${CONFIDENCE_BAND_LABELS[band].toLowerCase()} · ${String(Math.round(value as number))} %`
  return <StatusBadge tone={CONFIDENCE_BAND_TONES[band]}>{text}</StatusBadge>
}
