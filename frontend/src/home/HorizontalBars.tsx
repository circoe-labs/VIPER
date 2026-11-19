import { Link } from 'react-router'

const NUMBER = new Intl.NumberFormat('fr-FR')

export interface HBarPart {
  label: string
  value: number
  // A CSS colour (a theme token).
  color: string
}

export interface HBarRow {
  key: string
  label: string
  // Stacked parts of the bar (their sum is the row total); one part = a plain bar.
  parts: HBarPart[]
  // Where the row leads.
  href: string
}

// Horizontal bar list (one shared scale): each row is a link to the list it counts. Exact figures in the row text, in
// the tooltip, and in the accessible name; colour is never the only channel.
export function HorizontalBars({ caption, rows }: { caption: string; rows: HBarRow[] }) {
  const totals = rows.map((row) => row.parts.reduce((sum, part) => sum + part.value, 0))
  const max = Math.max(1, ...totals)
  return (
    <ul className="hbars" aria-label={caption}>
      {rows.map((row, index) => {
        const total = totals[index] ?? 0
        const detail = row.parts.length > 1 ? row.parts.map((part) => `${part.label} : ${NUMBER.format(part.value)}`).join(', ') : ''
        const summary = `${row.label} : ${NUMBER.format(total)}${detail ? ` (${detail})` : ''}`
        return (
          <li key={row.key}>
            <Link className="hbars__row" to={row.href} aria-label={summary} title={summary}>
              <span className="hbars__label">{row.label}</span>
              <span className="hbars__track" aria-hidden="true">
                <span className="hbars__bar" style={{ width: `${String((total / max) * 100)}%` }}>
                  {row.parts.map((part) => part.value > 0 && <span key={part.label} className="hbars__part" title={`${part.label} : ${NUMBER.format(part.value)}`} style={{ flexGrow: part.value, background: part.color }} />)}
                </span>
              </span>
              <strong className="hbars__value">{NUMBER.format(total)}</strong>
              <span className="hbars__detail">{row.parts.length > 1 ? row.parts.filter((part) => part.value > 0 && part !== row.parts[0]).map((part) => `dont ${NUMBER.format(part.value)} ${part.label.toLowerCase()}`).join(' · ') : ''}</span>
            </Link>
          </li>
        )
      })}
    </ul>
  )
}
