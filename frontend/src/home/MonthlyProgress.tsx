import type { HomeData, MonthProgress } from '../api/home'

type Metric = 'contacted' | 'appointments'

const MONTH = new Intl.DateTimeFormat('fr-FR', { month: 'long', year: 'numeric', timeZone: 'UTC' })
const SHORT_MONTH = new Intl.DateTimeFormat('fr-FR', { month: 'short', timeZone: 'UTC' })

// `2026-09-01` → « septembre 2026 » (the API's month is a calendar date, read as such).
function monthLabel(month: string): string {
  return MONTH.format(new Date(`${month}T00:00:00Z`))
}

function shortMonth(month: string): string {
  return SHORT_MONTH.format(new Date(`${month}T00:00:00Z`))
}

interface MetricProps {
  metric: Metric
  label: string
  target: number
  months: MonthProgress[]
}

// One month's figure against its informative target: the value, a thin meter (the target is the full track) and the
// six-month columns — the current month in the accent, earlier ones recessive. The meter's text alternative carries
// value, target and share; the columns are summarised by the table below.
function ProgressMetric({ metric, label, target, months }: MetricProps) {
  const values = months.map((month) => month[metric])
  const value = values.at(-1) ?? 0
  const peak = Math.max(...values, 1)
  const share = `${String(Math.round((value / target) * 100))} %`
  const id = `home-progress-${metric}`
  return (
    <div className="progress-metric">
      <div className="progress-metric__head">
        <h3 id={id} className="progress-metric__label">
          {label}
        </h3>
        <span className="progress-metric__value">{value}</span>
      </div>
      <div
        className="progress-metric__meter"
        role="meter"
        aria-labelledby={id}
        aria-valuemin={0}
        aria-valuemax={target}
        aria-valuenow={Math.min(value, target)}
        aria-valuetext={`${String(value)} sur un objectif indicatif de ${String(target)} (${share})`}
      >
        <span style={{ width: `${String(Math.min(value / target, 1) * 100)}%` }} />
      </div>
      <p className="progress-metric__target">
        Objectif indicatif : {target} · {share}
      </p>
      <ol className="spark" aria-hidden="true">
        {months.map((month, index) => (
          <li
            key={month.month}
            className={index === months.length - 1 ? 'spark__month spark__month--current' : 'spark__month'}
            title={`${monthLabel(month.month)} : ${String(month[metric])}`}
          >
            <span className="spark__bar" style={{ height: `${String((month[metric] / peak) * 100)}%` }} />
            <span className="spark__label">{shortMonth(month.month)}</span>
          </li>
        ))}
      </ol>
    </div>
  )
}

// Monthly progress (Task 16): informative, beside the recent activity — never the page's headline. Counted from the
// contact-tracking status history recorded in VIPER (doc/features/home-dashboard.md).
export function MonthlyProgress({ progress }: { progress: HomeData['progress'] }) {
  const current = progress.months.at(-1)
  return (
    <section className="home-panel home-progress" aria-labelledby="home-progress-title">
      <header className="home-panel__header">
        <h2 id="home-progress-title" className="home-panel__title">
          Progression du mois
        </h2>
        {current && <span className="home-panel__meta">{monthLabel(current.month)}</span>}
      </header>
      <ProgressMetric
        metric="contacted"
        label="Prospects contactés pour la première fois"
        target={progress.contact_target}
        months={progress.months}
      />
      <ProgressMetric
        metric="appointments"
        label="Rendez-vous obtenus"
        target={progress.appointment_target}
        months={progress.months}
      />
      <details className="home-progress__details">
        <summary>Détail des 6 derniers mois</summary>
        <div className="home-progress__table">
          <table>
            <caption className="visually-hidden">Progression des 6 derniers mois</caption>
            <thead>
              <tr>
                <th scope="col">Mois</th>
                <th scope="col">Contactés</th>
                <th scope="col">Rendez-vous</th>
              </tr>
            </thead>
            <tbody>
              {progress.months.map((month) => (
                <tr key={month.month}>
                  <th scope="row">{monthLabel(month.month)}</th>
                  <td>{month.contacted}</td>
                  <td>{month.appointments}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
      <p className="home-panel__note">
        Première prise de contact et premier rendez-vous enregistrés dans VIPER (changements d’étape du suivi) ; les
        étapes reprises d’un import ne comptent pas.
      </p>
    </section>
  )
}
