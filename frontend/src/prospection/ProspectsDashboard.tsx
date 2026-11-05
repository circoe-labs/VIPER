import { useQuery } from '@tanstack/react-query'
import { apiGet } from '../api/client'
import type { Review } from '../api/prospection'
import { Button } from '../ui/Button'
import { CheckCircleIcon, ChevronRightIcon, ClockIcon, MailIcon, SparklesIcon, UsersIcon } from '../ui/icons'

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
const STATUSES = [
  { key: 'verified', label: 'Validés', tone: 'green' },
] as const

export function ProspectsDashboard({
  stage,
  due,
  onStage,
  onDue,
}: {
  stage: string | null | undefined
  due: boolean
  onStage: (value: 'sent' | 'r1' | 'r2') => void
  onDue: () => void
}) {
  const query = useQuery({
    queryKey: ['prospection', 'dashboard', 'verification-validated'],
    queryFn: ({ signal }) => apiGet<DashboardData>('/prospection/dashboard?validated_only=true', signal),
  })
  const data = query.data
  if (query.isError)
    return (
      <div className="dashboard-panel" role="alert">
        Vue d’ensemble indisponible. <Button onClick={() => void query.refetch()}>Réessayer</Button>
      </div>
    )
  return (
    <>
      <section className="prospects-stats" aria-label="Vue d’ensemble de la base" aria-busy={query.isPending}>
        <article className="dashboard-panel stat-total">
          <span className="stat-icon tone-blue">
            <UsersIcon size={24} />
          </span>
          <h2>Total des prospects validés</h2>
          <strong className="stat-value">{data ? number.format(data.total) : '—'}</strong>
          <p>Fiches validées dans Vérification</p>
        </article>
        <article className="dashboard-panel stat-distribution">
          <h2>Base validée</h2>
          <div className="distribution-body">
            <div className="distribution-ring">
              <svg viewBox="0 0 120 120" aria-hidden="true">
                <circle cx="60" cy="60" r="48" className="donut-track" />
                {STATUSES.map(({ key, tone }, index) => {
                  const share = data && data.total > 0 ? (data.reviews[key] / data.total) * 100 : 0
                  const start =
                    data && data.total > 0
                      ? STATUSES.slice(0, index).reduce(
                          (sum, status) => sum + (data.reviews[status.key] / data.total) * 100,
                          0,
                        )
                      : 0
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
                <strong>{data ? number.format(data.total) : '—'}</strong>
                <small>prospects</small>
              </span>
            </div>
            <div className="distribution-legend">
              {STATUSES.map(({ key, label, tone }) => (
                <div
                  key={key}
                  title={
                    `${label} dans Vérification`
                  }
                >
                  <span className={`legend-dot tone-${tone}`} />
                  <span>{label}</span>
                  <strong>{data ? number.format(data.reviews[key]) : '—'}</strong>
                  <small>
                    {data
                      ? `${percent.format(data.total ? (data.reviews[key] / data.total) * 100 : 0)} %`
                      : '—'}
                  </small>
                </div>
              ))}
            </div>
          </div>
          <p className="distribution-note">Validation de la fiche, indépendante de celle de l’e-mail.</p>
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
      <section className="dashboard-panel sending-panel" aria-labelledby="sending-title">
        <div className="section-heading">
          <div>
            <h2 id="sending-title">Suivi des envois</h2>
            <p>Où en sont vos prospects dans le processus de prospection.</p>
          </div>
          <span className="section-caption">Envois réels · tout l’historique</span>
        </div>
        <div className="sending-stages">
          {(
            [
              { key: 'sent', label: 'Envoyé', detail: 'Premier e-mail envoyé', tone: 'blue', icon: MailIcon },
              {
                key: 'r1',
                label: 'R1',
                detail: 'Première relance effectuée',
                tone: 'green',
                icon: CheckCircleIcon,
              },
              {
                key: 'r2',
                label: 'R2',
                detail: 'Deuxième relance effectuée',
                tone: 'yellow',
                icon: CheckCircleIcon,
              },
            ] as const
          ).map(({ key, label, detail, tone, icon: Icon }, index) => (
            <div className="sending-stage-wrap" key={key}>
              <button
                type="button"
                className={`sending-stage tone-${tone}`}
                aria-label={`${label} · ${detail} : ${data ? number.format(data.sends[key]) : 'chargement'} prospects`}
                aria-pressed={stage === key}
                onClick={() => {
                  onStage(key)
                }}
                title="Nombre de prospects ayant atteint cette étape dans leur historique ; les étapes peuvent se recouper."
              >
                <Icon size={22} />
                <span>
                  {label}
                  <small>{detail}</small>
                </span>
                <strong>{data ? number.format(data.sends[key]) : '—'}</strong>
              </button>
              {index < 2 && <ChevronRightIcon className="stage-arrow" size={18} />}
            </div>
          ))}
          <button
            type="button"
            className="sending-stage sending-stage--due"
            aria-pressed={due}
            onClick={onDue}
          >
            <ClockIcon size={22} />
            <span>
              À traiter<small>Envois échus et éligibles</small>
            </span>
            <strong>{data ? number.format(data.due) : '—'}</strong>
          </button>
        </div>
      </section>
    </>
  )
}
