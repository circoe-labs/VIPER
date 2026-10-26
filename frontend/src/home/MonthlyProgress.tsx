import type { HomeData } from '../api/home'

const MONTH = new Intl.DateTimeFormat('fr-FR', { month: 'long', year: 'numeric', timeZone: 'UTC' })

// `2026-09-01` → « septembre 2026 » (the API's month is a calendar date, read as such).
function monthLabel(month: string): string {
  return MONTH.format(new Date(`${month}T00:00:00Z`))
}

const RADIUS = 15.9155 // a circle of circumference 100: slice lengths read as percentages

interface Slice {
  key: string
  label: string
  value: number
  color: string
}

// The month's results as a pie: prospects contacted for the first time, split into appointment taken, answered without
// an appointment yet, and no answer yet. Counted from what VIPER recorded (doc/features/home-dashboard.md); the
// slices are clamped so that a prospect answering this month who was contacted earlier never makes one negative.
export function MonthlyProgress({ progress, figures }: { progress: HomeData['progress']; figures: HomeData['figures'] }) {
  const current = progress.months.at(-1)
  const appointments = current?.appointments ?? 0
  const contacted = current?.contacted ?? 0
  const answered = Math.max(figures.responses_this_month - appointments, 0)
  const slices: Slice[] = [
    { key: 'appointments', label: 'RDV pris', value: appointments, color: 'var(--color-success-fg)' },
    { key: 'answered', label: 'Réponse sans RDV', value: answered, color: 'var(--color-info-fg)' },
    {
      key: 'waiting',
      label: 'Sans réponse',
      value: Math.max(contacted - appointments - answered, 0),
      color: 'var(--color-warning-fg)',
    },
  ]
  const total = slices.reduce((sum, slice) => sum + slice.value, 0)
  let offset = 0
  return (
    <section className="home-panel home-progress" aria-labelledby="home-progress-title">
      <header className="home-panel__header">
        <h2 id="home-progress-title" className="home-panel__title">
          Progression du mois
        </h2>
        {current && <span className="home-panel__meta">{monthLabel(current.month)}</span>}
      </header>
      {total === 0 ? (
        <p className="home-panel__empty">Aucun résultat enregistré ce mois-ci.</p>
      ) : (
        <div className="month-pie">
          <svg viewBox="0 0 42 42" className="month-pie__chart" role="img" aria-label="Résultats du mois">
            {slices.map((slice) => {
              const length = (slice.value / total) * 100
              const start = offset
              offset += length
              return slice.value > 0 ? (
                <circle
                  key={slice.key}
                  cx="21"
                  cy="21"
                  r={RADIUS}
                  fill="none"
                  stroke={slice.color}
                  strokeWidth="9"
                  strokeDasharray={`${String(length)} ${String(100 - length)}`}
                  strokeDashoffset={String(25 - start)}
                />
              ) : null
            })}
          </svg>
          <ul className="month-pie__legend">
            {slices.map((slice) => (
              <li key={slice.key}>
                <span className="month-pie__swatch" style={{ background: slice.color }} aria-hidden="true" />
                {slice.label} <strong>{slice.value}</strong>
              </li>
            ))}
          </ul>
        </div>
      )}
      <p className="home-panel__note">
        Prospects contactés pour la première fois ce mois-ci, selon leur résultat : RDV pris, réponse sans RDV ou sans
        réponse.
      </p>
    </section>
  )
}
