import { type ContactChartBar } from '../api/contact'
import { Button } from '../ui/Button'

const NUMBER = new Intl.NumberFormat('fr-FR')
const COLORS = ['var(--nc-contacts-chart-blue)', 'var(--nc-contacts-chart-green)', 'var(--nc-contacts-chart-orange)', 'var(--nc-contacts-chart-purple)', 'var(--nc-contacts-chart-pink)']

export function ContactChart({ bars, total, loading, error, onRetry }: {
  bars: ContactChartBar[] | undefined
  total: number | undefined
  loading: boolean
  error: boolean
  onRetry: () => void
}) {
  const peak = Math.max(1, ...(bars ?? []).map((bar) => bar.count))
  const step = Math.max(1, Math.ceil(peak / 4))
  const maximum = step * 4
  return (
    <section className="contacts-chart" aria-labelledby="contacts-chart-title">
      <h2 id="contacts-chart-title">{total === 1 ? 'Répartition de 1 contact' : `Répartition des ${total === undefined ? '—' : NUMBER.format(total)} contacts`}</h2>
      <p className="contacts-chart__caption">Selon le dernier envoi enregistré.</p>
      {loading && <p role="status">Chargement du graphique…</p>}
      {error && <p role="alert">Graphique indisponible. <Button size="sm" onClick={onRetry}>Réessayer</Button></p>}
      {bars && !error && (
        <div className="contacts-chart__scroll" tabIndex={0} role="region" aria-label="Graphique des contacts">
          <div className="contacts-chart__canvas">
            <div className="contacts-chart__plot" role="img" aria-label={bars.map((bar) => `${bar.label} : ${NUMBER.format(bar.count)}`).join(' ; ')}>
              <div className="contacts-chart__grid" aria-hidden="true">
                {[4, 3, 2, 1, 0].map((tick) => <div key={tick}><span>{NUMBER.format(step * tick)}</span><i /></div>)}
              </div>
              <div className="contacts-chart__bars" aria-hidden="true">
                {bars.map((bar) => <div className="contacts-chart__column" key={bar.slot}>
                  <div className="contacts-chart__bar" style={{ height: `${String(bar.count / maximum * 100)}%`, background: COLORS[bar.slot] }}>
                    <span>{NUMBER.format(bar.count)}</span>
                  </div>
                </div>)}
              </div>
            </div>
            <div className="contacts-chart__labels" aria-hidden="true">
              {bars.map((bar) => <span key={bar.slot}>{bar.label}</span>)}
            </div>
          </div>
        </div>
      )}
    </section>
  )
}
