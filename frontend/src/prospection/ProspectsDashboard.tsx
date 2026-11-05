import { useQuery } from '@tanstack/react-query'
import { apiGet } from '../api/client'
import { useProspectPage, type Review } from '../api/prospection'
import { useUncertainAlerts } from '../api/sequences'
import { todoCriteria } from './verificationFigures'
import { Button } from '../ui/Button'
import { SparklesIcon, UsersIcon } from '../ui/icons'

export interface DashboardData {
  total: number
  reviews: Record<Review, number>
  sends: Record<'sent' | 'r1' | 'r2', number>
  due: number
  average_quality: number | null
  scored_count: number
}
const number = new Intl.NumberFormat('fr-FR')
const percent = new Intl.NumberFormat('fr-FR', { maximumFractionDigits: 1 })

export function ProspectsDashboard() {
  const query = useQuery({
    queryKey: ['prospection', 'dashboard', 'verification-validated'],
    queryFn: ({ signal }) => apiGet<DashboardData>('/prospection/dashboard?validated_only=true', signal),
  })
  const data = query.data
  const never = useProspectPage(todoCriteria(), 1)
  const alerts = useUncertainAlerts()
  const uncertain = never.data && alerts.data
    ? Math.min(new Set(alerts.data.items.flatMap((alert) => alert.prospect_id ? [alert.prospect_id] : [])).size, never.data.total)
    : null
  const distributionTotal = data && uncertain !== null ? data.total + uncertain : null
  const statuses = [
    { key: 'verified', label: 'Validés', tone: 'green', count: data?.total ?? null },
    { key: 'uncertain', label: 'Incertains', tone: 'yellow', count: uncertain },
  ] as const
  if (query.isError)
    return (
      <div className="dashboard-panel" role="alert">
        Vue d’ensemble indisponible. <Button onClick={() => void query.refetch()}>Réessayer</Button>
      </div>
    )
  return (
    <>
      <section className="prospects-stats" aria-label="Vue d’ensemble de la base" aria-busy={query.isPending || never.isPending || alerts.isPending}>
        <article className="dashboard-panel stat-total">
          <span className="stat-icon tone-blue">
            <UsersIcon size={24} />
          </span>
          <h2>Total des prospects validés</h2>
          <strong className="stat-value">{data ? number.format(data.total) : '—'}</strong>
          <p>Fiches validées dans Vérification</p>
        </article>
        <article className="dashboard-panel stat-distribution">
          <h2>Validés et incertains</h2>
          <div className="distribution-body">
            <div className="distribution-ring">
              <svg viewBox="0 0 120 120" aria-hidden="true">
                <circle cx="60" cy="60" r="48" className="donut-track" />
                {statuses.map(({ key, tone, count }, index) => {
                  const share = distributionTotal && count !== null ? (count / distributionTotal) * 100 : 0
                  const start = index === 0 || !distributionTotal ? 0 : ((statuses[0].count ?? 0) / distributionTotal) * 100
                  return (
                    <circle
                      key={key}
                      cx="60"
                      cy="60"
                      r="48"
                      pathLength="100"
                      className={`donut-arc tone-${tone}`}
                      strokeDasharray={`${String(share)} ${String(100 - share)}`}
                      strokeDashoffset={-start}
                      transform="rotate(-90 60 60)"
                    />
                  )
                })}
              </svg>
              <span>
                <strong>{distributionTotal !== null ? number.format(distributionTotal) : '—'}</strong>
                <small>prospects</small>
              </span>
            </div>
            <div className="distribution-legend">
              {statuses.map(({ key, label, tone, count }) => (
                <div key={key} title={`${label} dans Vérification`}>
                  <span className={`legend-dot tone-${tone}`} />
                  <span>{label}</span>
                  <strong>{count !== null ? number.format(count) : '—'}</strong>
                  <small>
                    {count !== null && distributionTotal !== null
                      ? `${percent.format(distributionTotal ? (count / distributionTotal) * 100 : 0)} %`
                      : '—'}
                  </small>
                </div>
              ))}
            </div>
          </div>
          <p className="distribution-note">{never.isError || alerts.isError ? 'Nombre de prospects incertains indisponible.' : 'Incertains : fiches avec une fonction à vérifier. La liste reste limitée aux prospects validés.'}</p>
        </article>
        <article className="dashboard-panel stat-quality">
          <span className="stat-icon tone-green">
            <SparklesIcon size={24} />
          </span>
          <h2>Fiabilité moyenne</h2>
          <strong className="stat-value">
            {data?.average_quality != null ? `${percent.format(data.average_quality)} %` : '—'}
          </strong>
          <p>
            {data
              ? data.scored_count > 0
                ? `Qualité des données · ${number.format(data.scored_count)} fiches évaluées`
                : 'Aucun score disponible'
              : 'Chargement des scores…'}
          </p>
          <span className="stat-footnote">Fiches en opposition exclues</span>
        </article>
      </section>
    </>
  )
}
