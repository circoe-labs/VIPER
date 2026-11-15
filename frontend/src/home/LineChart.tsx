import type { BarColumn, BarSeries } from './StackedBars'
import { niceMax } from './weekBars'

const NUMBER = new Intl.NumberFormat('fr-FR')

// Week-by-week line chart, hand drawn like StackedBars: one curve per series, one shared scale. The SVG is stretched
// to its box (non-scaling strokes keep the lines crisp); axis labels are HTML. Same figures in a hidden table.
export function LineChart({ caption, columns, series }: { caption: string; columns: BarColumn[]; series: BarSeries[] }) {
  const top = niceMax(Math.max(0, ...series.flatMap((entry) => entry.values)))
  const count = columns.length
  const x = (index: number) => (count > 1 ? (index / (count - 1)) * 100 : 50)
  const y = (value: number) => 100 - (value / top) * 100
  const ticks = [top, (top * 3) / 4, top / 2, top / 4, 0]
  return (
    <div className="line-chart">
      <div className="line-chart__plot" aria-hidden="true">
        <div className="line-chart__axis">{ticks.map((tick) => <span key={tick}>{NUMBER.format(Math.round(tick))}</span>)}</div>
        <div className="line-chart__area">
          <svg viewBox="0 0 100 100" preserveAspectRatio="none">
            {ticks.map((tick) => <line key={tick} className="line-chart__grid" x1="0" x2="100" y1={y(tick)} y2={y(tick)} />)}
            {series.map((entry) => (
              <polyline key={entry.key} className="line-chart__line" stroke={entry.color} points={entry.values.map((value, index) => `${String(x(index))},${String(y(value))}`).join(' ')} />
            ))}
          </svg>
          <div className="line-chart__hits" style={{ gridTemplateColumns: `repeat(${String(count)}, minmax(0, 1fr))` }}>
            {columns.map((column, index) => (
              <div
                key={column.title}
                className="line-chart__hit"
                title={`${column.label} (${column.title}) — ${series.map((entry) => `${entry.label} : ${NUMBER.format(entry.values[index] ?? 0)}`).join(', ')}`}
              />
            ))}
          </div>
        </div>
        <div className="line-chart__labels" style={{ gridTemplateColumns: `repeat(${String(count)}, minmax(0, 1fr))` }}>
          {columns.map((column) => <span key={column.title}>{column.label}</span>)}
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
