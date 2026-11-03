import { SIGNAL_KIND_LABELS } from '../agents/labels'
import { useCompanySignals } from '../api/companySignals'
import { Section } from './CompanyEditorParts'

// The company page reads the signals stored for it and its people: dated, sourced facts the
// missions proposed and a person accepted. Read-only here — the review lives in Missions.
export function CompanySignals({ companyId }: { companyId: string }) {
  const signals = useCompanySignals(companyId)

  if (signals.isLoading) {
    return (
      <Section title="Signaux">
        <p className="company-signals__empty">Chargement…</p>
      </Section>
    )
  }
  if (signals.isError) {
    return (
      <Section title="Signaux">
        <p className="company-signals__empty">Les signaux n’ont pas pu être chargés.</p>
      </Section>
    )
  }
  const rows = signals.data ?? []
  return (
    <Section title="Signaux" count={rows.length}>
      {rows.length === 0 ? (
        <p className="company-signals__empty">
          Aucun signal enregistré. Les missions de veille en proposent, à valider dans Missions.
        </p>
      ) : (
        <ul className="company-signals">
          {rows.map((row) => (
            <li key={row.id} className="company-signal">
              <div className="company-signal__head">
                <span className="company-signal__kind">
                  {SIGNAL_KIND_LABELS[row.kind ?? ''] ?? row.kind ?? 'Signal'}
                </span>
                <span className="company-signal__subject">{row.subject}</span>
                {row.observed_on && <span className="company-signal__date">{row.observed_on}</span>}
                {row.score_delta !== null && (
                  <span className={`company-signal__score${row.score_delta < 0 ? ' is-negative' : ''}`}>
                    {row.score_delta > 0 ? '+' : ''}
                    {String(row.score_delta)}
                  </span>
                )}
              </div>
              <p className="company-signal__text">{row.signal}</p>
              <div className="company-signal__foot">
                {row.source_url && (
                  <a href={row.source_url} target="_blank" rel="noreferrer noopener">
                    source
                  </a>
                )}
                {row.relevance !== null && <span>pertinence {String(row.relevance)}</span>}
                <span>{row.origin === 'agent' ? 'proposé par un agent' : 'saisi à la main'}</span>
              </div>
            </li>
          ))}
        </ul>
      )}
    </Section>
  )
}
