import { niceMax } from './weekBars'

export interface BarSeries {
  key: string
  label: string
  // A CSS colour (a theme token), so the chart follows the dark and the light theme.
  color: string
  values: number[]
}

export interface BarColumn {
  // Short axis label (`S43`) and the full description used by the hover and the accessible table.
  label: string
  title: string
}

interface StackedBarsProps {
  caption: string
  columns: BarColumn[]
  series: BarSeries[]
  // `compact` = small multiple: shorter plot, no gridline labels.
  compact?: boolean
}

const NUMBER = new Intl.NumberFormat('fr-FR')

// One week-by-week column chart, hand drawn (no chart library in the app). A single series is a plain bar chart, several
// are stacked. The columns are decorative: the same figures are exposed as a visually hidden table.
export function StackedBars({ caption, columns, series, compact = false }: StackedBarsProps) {
  const totals = columns.map((_, index) => series.reduce((sum, entry) => sum + (entry.values[index] ?? 0), 0))
  const top = niceMax(Math.max(0, ...totals))
  const ticks = compact ? [] : [top, top / 2, 0]
  return (
    <div className={`week-bars${compact ? ' week-bars--compact' : ''}`}>
      <div className="week-bars__plot" aria-hidden="true">
        {ticks.length > 0 && (
          <div className="week-bars__axis">
            {ticks.map((tick) => <span key={tick}>{NUMBER.format(tick)}</span>)}
          </div>
        )}
        <div className="week-bars__columns" style={{ gridTemplateColumns: `repeat(${String(columns.length)}, minmax(0, 1fr))` }}>
          {columns.map((column, index) => (
            <div className="week-bars__column" key={column.title} title={`${column.label} (${column.title}) : ${NUMBER.format(totals[index] ?? 0)}`}>
              <div className="week-bars__stack">
                {series.map((entry) => {
                  const value = entry.values[index] ?? 0
                  return value > 0 ? <span key={entry.key} className="week-bars__segment" style={{ height: `${String((value / top) * 100)}%`, background: entry.color }} /> : null
                })}
              </div>
              <span className="week-bars__label">{column.label}</span>
            </div>
          ))}
        </div>
      </div>
      <table className="visually-hidden">
        <caption>{caption}</caption>
        <thead>
          <tr><th scope="col">Semaine</th>{series.map((entry) => <th scope="col" key={entry.key}>{entry.label}</th>)}</tr>
        </thead>
        <tbody>
          {columns.map((column, index) => (
            <tr key={column.title}>
              <th scope="row">{column.label} ({column.title})</th>
              {series.map((entry) => <td key={entry.key}>{NUMBER.format(entry.values[index] ?? 0)}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
