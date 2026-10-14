const RADIUS = 15.9155 // a circle of circumference 100: slice lengths read as percentages

export interface SendCounts {
  r2: number
  r1: number
  sent: number
  total: number
}

// The rows by sending state, as a pie: R2 (red), R1 (orange), Envoyé (green) and the others (blue, not sent yet or
// without a cohort); the total of rows in the middle. Same colours as the Home campaign pie.
export function SendPie({ counts }: { counts: SendCounts }) {
  const others = Math.max(counts.total - counts.r2 - counts.r1 - counts.sent, 0)
  const slices = [
    { key: 'r2', label: 'R2', value: counts.r2, color: 'var(--color-danger-fg)' },
    { key: 'r1', label: 'R1', value: counts.r1, color: 'var(--color-warning-fg)' },
    { key: 'sent', label: 'Envoyé', value: counts.sent, color: 'var(--color-success-fg)' },
    { key: 'others', label: 'Autres', value: others, color: 'var(--color-info-fg)' },
  ]
  const starts = slices.map((_, index) =>
    slices.slice(0, index).reduce((sum, slice) => sum + (counts.total > 0 ? (slice.value / counts.total) * 100 : 0), 0),
  )
  return (
    <div className="send-pie">
      <svg viewBox="0 0 42 42" className="send-pie__chart" role="img" aria-label="Lignes par état d’envoi">
        {slices.map((slice, index) => {
          const length = counts.total > 0 ? (slice.value / counts.total) * 100 : 0
          return slice.value > 0 ? (
            <circle
              key={slice.key}
              cx="21"
              cy="21"
              r={RADIUS}
              fill="none"
              stroke={slice.color}
              strokeWidth="7"
              strokeDasharray={`${String(length)} ${String(100 - length)}`}
              strokeDashoffset={String(25 - (starts[index] ?? 0))}
            />
          ) : null
        })}
        <text x="21" y="21.5" textAnchor="middle" className="send-pie__total">
          {counts.total}
        </text>
        <text x="21" y="26.5" textAnchor="middle" className="send-pie__caption">
          prospects
        </text>
      </svg>
      <ul className="send-pie__legend">
        {slices.map((slice) => (
          <li key={slice.key}>
            <span className="send-pie__swatch" style={{ background: slice.color }} aria-hidden="true" />
            {slice.label} <strong>{slice.value}</strong>
          </li>
        ))}
      </ul>
    </div>
  )
}
