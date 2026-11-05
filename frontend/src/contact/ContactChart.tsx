import { useState } from 'react'

import { type ContactChartBar, useChartDateMutation } from '../api/contact'
import { Button } from '../ui/Button'
import { CalendarIcon, CloseIcon, SaveIcon } from '../ui/icons'

const NUMBER = new Intl.NumberFormat('fr-FR')
const COLORS = ['var(--nc-contacts-chart-blue)', 'var(--nc-contacts-chart-green)', 'var(--nc-contacts-chart-orange)', 'var(--nc-contacts-chart-purple)', 'var(--nc-contacts-chart-pink)']

function ChartDate({ bar }: { bar: ContactChartBar }) {
  const [value, setValue] = useState(bar.send_date ?? '')
  const save = useChartDateMutation()
  const changed = value !== (bar.send_date ?? '')
  async function persist(date: string) {
    if (save.isPending) return
    try { await save.mutateAsync({ slot: bar.slot, date: date || null }) } catch { /* The field keeps the draft for retry. */ }
  }
  return (
    <div className="contacts-chart__date-group">
      <label className="contacts-chart__date">
        <CalendarIcon size={16} />
        <span className="visually-hidden">Date d’envoi du graphique — {bar.label}</span>
        <input type="date" value={value} disabled={save.isPending} onChange={(event) => {
          setValue(event.target.value)
          save.reset()
        }} onBlur={() => { if (changed) void persist(value) }} />
      </label>
      <div className="contacts-chart__date-actions">
        {value && <Button size="sm" variant="ghost" icon={CloseIcon} disabled={save.isPending} aria-label={`Effacer la date — ${bar.label}`} onMouseDown={(event) => { event.preventDefault(); }} onClick={() => {
          setValue('')
          void persist('')
        }} />}
        {changed && <Button size="sm" variant="ghost" icon={SaveIcon} disabled={save.isPending} aria-label={`Enregistrer la date — ${bar.label}`} onMouseDown={(event) => { event.preventDefault(); }} onClick={() => void persist(value)} />}
      </div>
      <p className="contacts-chart__date-status" role="status">
        {save.isError ? 'Échec : réessayez.' : save.isPending ? 'Enregistrement…' : save.isSuccess && !changed ? 'Enregistrée' : ''}
      </p>
    </div>
  )
}

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
      <p className="contacts-chart__caption">Selon le dernier envoi enregistré. Les dates ci-dessous sont des repères indépendants.</p>
      {loading && <p role="status">Chargement du graphique…</p>}
      {error && <p role="alert">Graphique indisponible. <Button size="sm" onClick={onRetry}>Réessayer</Button></p>}
      {bars && !error && (
        <div className="contacts-chart__scroll" tabIndex={0} role="region" aria-label="Graphique des contacts et dates d’envoi">
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
            <div className="contacts-chart__dates">
              {bars.map((bar) => <ChartDate key={`${String(bar.slot)}-${bar.send_date ?? 'empty'}`} bar={bar} />)}
            </div>
          </div>
        </div>
      )}
    </section>
  )
}
