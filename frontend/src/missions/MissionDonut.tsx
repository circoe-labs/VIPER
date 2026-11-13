import { Table } from '../ui/Table'
import { type DonutInput, donutModel, donutSummary, formatDonutCount, formatShare } from './donutModel'
import './missionUi.css'

interface MissionDonutProps {
  title: string
  segments: DonutInput[]
  // What is counted, plural (« appels », « tâches »): the ring centre, the total line and the table header.
  unit: string
  // Shown when every figure is 0: an explicit absence, never an empty ring.
  emptyText?: string
}

// Ring gap between two arcs, in pathLength units (out of 100).
const GAP = 0.8
const RADIUS = 40

// Categorical donut with its own text alternative: ring (decorative, summarised by role="img"), a legend that
// states label + figure + share (colour is never the only channel), and the same data as a table in a disclosure.
// Only for a compact part-of-whole of mutually exclusive categories (CONTRACT.md §2.5).
export function MissionDonut({ title, segments, unit, emptyText = 'Aucune donnée sur la période.' }: MissionDonutProps) {
  const model = donutModel(segments)
  if (model.total === 0) {
    return (
      <p className="mui-state" role="status">
        {emptyText}
      </p>
    )
  }
  const drawn = model.segments.filter((segment) => segment.length > 0)
  const gap = drawn.length > 1 ? GAP : 0
  return (
    <div className="mui-donut">
      <svg
        className="mui-donut__ring"
        viewBox="0 0 100 100"
        role="img"
        aria-label={donutSummary(title, model, unit)}
        focusable="false"
      >
        <circle className="mui-donut__track" cx="50" cy="50" r={RADIUS} />
        <g transform="rotate(-90 50 50)">
          {drawn.map((segment) => {
            const length = Math.max(segment.length - gap, 0.01)
            return (
              <circle
                key={segment.key}
                className="mui-donut__arc"
                data-hue={segment.hue}
                cx="50"
                cy="50"
                r={RADIUS}
                pathLength={100}
                strokeDasharray={`${String(length)} ${String(100 - length)}`}
                strokeDashoffset={-(segment.start + gap / 2)}
              />
            )
          })}
        </g>
        <text className="mui-donut__total" x="50" y="47" textAnchor="middle" dominantBaseline="central">
          {formatDonutCount(model.total)}
        </text>
        <text className="mui-donut__unit" x="50" y="61" textAnchor="middle" dominantBaseline="central">
          {unit}
        </text>
      </svg>
      <ul className="mui-donut__legend" aria-label={`${title} : légende`}>
        {model.segments.map((segment) => (
          <li key={segment.key} className="mui-donut__row" data-hue={segment.hue}>
            <span className="mui-donut__swatch" aria-hidden="true" />
            <span className="mui-donut__label">{segment.label}</span>
            <span className="mui-donut__value">{formatDonutCount(segment.value)}</span>
            <span className="mui-donut__share">{formatShare(segment.share)}</span>
          </li>
        ))}
      </ul>
      <details className="mui-donut__data">
        <summary>Voir les données en tableau</summary>
        <Table caption={`${title} : données`} density="compact">
          <thead>
            <tr>
              <th scope="col">Catégorie</th>
              <th scope="col" className="mui-num">
                {unit}
              </th>
              <th scope="col" className="mui-num">
                Part
              </th>
            </tr>
          </thead>
          <tbody>
            {model.segments.map((segment) => (
              <tr key={segment.key}>
                <th scope="row">{segment.label}</th>
                <td className="mui-num">{formatDonutCount(segment.value)}</td>
                <td className="mui-num">{formatShare(segment.share)}</td>
              </tr>
            ))}
          </tbody>
        </Table>
      </details>
    </div>
  )
}
