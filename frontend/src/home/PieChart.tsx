const NUMBER = new Intl.NumberFormat('fr-FR')
const PERCENT = new Intl.NumberFormat('fr-FR', { style: 'percent', maximumFractionDigits: 1 })

export interface PieSlice {
  key: string
  label: string
  value: number
  // A CSS colour (a theme token).
  color: string
}

const point = (angle: number): string => `${(50 + 48 * Math.sin(angle)).toFixed(3)} ${(50 - 48 * Math.cos(angle)).toFixed(3)}`

// Hand-drawn pie of exclusive categories: hover a slice for its value, the legend states label + figure + share
// (colour is never the only channel).
export function PieChart({ caption, slices }: { caption: string; slices: PieSlice[] }) {
  const total = slices.reduce((sum, slice) => sum + slice.value, 0)
  const summary = `${caption} : ${slices.map((slice) => `${slice.label} : ${NUMBER.format(slice.value)}`).join(', ')}`
  // Start angle of each slice = cumulative share of the previous ones.
  const starts = slices.map((_, index) => slices.slice(0, index).reduce((sum, slice) => sum + slice.value, 0))
  return (
    <div className="pie">
      <svg className="pie__chart" viewBox="0 0 100 100" role="img" aria-label={summary}>
        {total === 0 && <circle className="gauge__track" cx="50" cy="50" r="48" />}
        {slices.map((slice, index) => {
          if (slice.value <= 0 || total === 0) return null
          const share = slice.value / total
          const start = ((starts[index] ?? 0) / total) * 2 * Math.PI
          const end = start + share * 2 * Math.PI
          const title = <title>{`${slice.label} : ${NUMBER.format(slice.value)} (${PERCENT.format(share)})`}</title>
          if (share >= 0.9999) return <circle key={slice.key} cx="50" cy="50" r="48" fill={slice.color}>{title}</circle>
          const large = share > 0.5 ? 1 : 0
          return (
            <path key={slice.key} className="pie__slice" fill={slice.color} d={`M 50 50 L ${point(start)} A 48 48 0 ${String(large)} 1 ${point(end)} Z`}>
              {title}
            </path>
          )
        })}
      </svg>
      <ul className="pie__legend" aria-label={`${caption} : légende`}>
        {slices.map((slice) => (
          <li key={slice.key}>
            <span className="chart-legend__swatch" style={{ background: slice.color }} aria-hidden="true" />
            {slice.label}
            <strong>{NUMBER.format(slice.value)}</strong>
            <small>{total > 0 ? PERCENT.format(slice.value / total) : '–'}</small>
          </li>
        ))}
      </ul>
    </div>
  )
}
