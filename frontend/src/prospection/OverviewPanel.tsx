import { useProspectionOverview } from '../api/prospection'
import './overview.css'

const NUMBER = new Intl.NumberFormat('fr-FR')
const PERCENT = new Intl.NumberFormat('fr-FR', { style: 'percent', maximumFractionDigits: 0 })

// The whole base in three exact figures — people held, contacted, deleted since the start — and one bar showing how much
// of the base has been reached. Not narrowed by the search or the filters below: these are the base's own numbers.
export function OverviewPanel() {
  const overview = useProspectionOverview()
  const data = overview.data
  if (overview.isError) {
    return (
      <section className="overview" aria-labelledby="overview-title">
        <h2 id="overview-title" className="eyebrow">
          Bilan de la base
        </h2>
        <p className="overview__error" role="alert">
          Bilan indisponible ({overview.error.message}).
        </p>
      </section>
    )
  }
  const notContacted = data ? Math.max(data.total - data.contacted, 0) : 0
  const share = data && data.total > 0 ? data.contacted / data.total : 0
  return (
    <section className="overview" aria-labelledby="overview-title">
      <h2 id="overview-title" className="eyebrow">
        Bilan de la base
      </h2>
      <dl className="overview__figures">
        <div className="overview__figure">
          <dt>Prospects actuellement dans la base</dt>
          <dd>{data ? NUMBER.format(data.total) : '–'}</dd>
        </div>
        <div className="overview__figure overview__figure--contacted">
          <dt>Contactés</dt>
          <dd>{data ? NUMBER.format(data.contacted) : '–'}</dd>
        </div>
        <div className="overview__figure overview__figure--deleted">
          <dt>Supprimés (déjà retirés de la base)</dt>
          <dd>{data ? NUMBER.format(data.deleted) : '–'}</dd>
        </div>
      </dl>
      {data && data.total > 0 && (
        <figure className="overview__chart">
          <svg
            viewBox="0 0 100 4"
            preserveAspectRatio="none"
            role="img"
            aria-label={`${NUMBER.format(data.contacted)} prospects contactés sur ${NUMBER.format(data.total)} (${PERCENT.format(share)}), ${NUMBER.format(notContacted)} pas encore contactés`}
          >
            <rect className="overview__bar-rest" x="0" y="0" width="100" height="4" rx="1" />
            <rect className="overview__bar-contacted" x="0" y="0" width={share * 100} height="4" rx="1" />
          </svg>
          <figcaption>
            <span className="overview__key overview__key--contacted">
              Contactés : {NUMBER.format(data.contacted)} ({PERCENT.format(share)})
            </span>
            <span className="overview__key">Pas encore contactés : {NUMBER.format(notContacted)}</span>
          </figcaption>
        </figure>
      )}
    </section>
  )
}
