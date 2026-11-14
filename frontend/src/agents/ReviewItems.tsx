import type { ProposalItem } from '../api/agents'
import { ReviewEvidence } from './ReviewEvidence'
import { SIGNAL_KIND_LABELS } from './labels'
import { safeHref, sourceLabel } from './reviewFormat'

export function shown(value: unknown): string {
  if (value === null || value === undefined || value === '') return '—'
  if (Array.isArray(value)) {
    return value.length === 0 ? '—' : value.map((item) => shown(item)).join(', ')
  }
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return value.toString()
  return JSON.stringify(value)
}

function signalValue(item: ProposalItem, key: string): string {
  const value = item.store?.[key]
  return typeof value === 'string' ? value : ''
}

function textOf(record: Record<string, unknown>, key: string): string {
  const value = record[key]
  if (typeof value === 'string') return value
  if (typeof value === 'number') return value.toString()
  return ''
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function SourceLink({ href }: { href: string }) {
  const safe = safeHref(href)
  return safe ? (
    <a className="review-source-link" href={safe} target="_blank" rel="noreferrer noopener" title={safe}>{sourceLabel(safe)}</a>
  ) : null
}

// A discovered company's sites and the dated event that brought it in (`find_prospects`). Results
// submitted before these fields existed carry neither key and show nothing here.
export function DiscoveryDetails({ item }: { item: ProposalItem }) {
  const rawSites = item.store?.establishments
  const sites = Array.isArray(rawSites) ? rawSites.filter(isRecord) : []
  const trigger = isRecord(item.store?.trigger) ? item.store.trigger : null
  const detailFields: [string, string][] = [
    ['Raison sociale', 'legal_name'], ['SIREN', 'siren'], ['Site web', 'website_url'],
    ['Domaine e-mail', 'email_domain'], ['Effectif', 'size_label'],
  ]
  const details = detailFields
    .map(([label, key]): [string, string] => [label, textOf(item.store ?? {}, key)])
    .filter(([, value]) => value)
  if (sites.length === 0 && !trigger && details.length === 0) return null
  const kind = trigger ? textOf(trigger, 'kind') : ''
  const score = trigger?.score_delta
  return (
    <div className="review-discovery">
      {details.length > 0 && <p>{details.map(([label, value]) => `${label} : ${value}`).join(' · ')}</p>}
      {sites.length > 0 && (
        <ul className="review-discovery__sites" aria-label="Établissements">
          {sites.map((site, index) => {
            const place = [textOf(site, 'postal_code'), textOf(site, 'city')].filter(Boolean).join(' ')
            const surface = textOf(site, 'surface_m2')
            return (
              <li key={textOf(site, 'siret') || `${place}-${String(index)}`}>
                <strong>{textOf(site, 'name') || place || 'Établissement'}</strong>
                {textOf(site, 'kind') && <span>{textOf(site, 'kind')}</span>}
                {place && <span>{place}</span>}
                {textOf(site, 'siret') && <span>SIRET {textOf(site, 'siret')}</span>}
                {textOf(site, 'opened_on') && <span>ouvert le {textOf(site, 'opened_on')}</span>}
                {surface && <span>{surface} m²</span>}
                <SourceLink href={textOf(site, 'source')} />
              </li>
            )
          })}
        </ul>
      )}
      {trigger && (
        <div className="review-discovery__trigger" role="group" aria-label="Déclencheur">
          <span className="review-signal__kind">{SIGNAL_KIND_LABELS[kind] ?? kind}</span>
          <span>{textOf(trigger, 'observed_on')}</span>
          <span className="review-signal__text">{textOf(trigger, 'signal')}</span>
          {typeof score === 'number' && (
            <span className={score < 0 ? 'review-signal__score is-negative' : 'review-signal__score'}>
              {score > 0 ? '+' : ''}
              {String(score)}
            </span>
          )}
          {textOf(trigger, 'score_reason') && (
            <span className="review-discovery__reason">{textOf(trigger, 'score_reason')}</span>
          )}
          <SourceLink href={textOf(trigger, 'source_url')} />
        </div>
      )}
    </div>
  )
}

interface RowProps {
  item: ProposalItem
  checked: boolean
  // Decided results are shown as they were decided: no checkbox can change.
  locked: boolean
  onToggle: () => void
}

export function SignalRow({ item, checked, locked, onToggle }: RowProps) {
  const kind = signalValue(item, 'kind')
  const subject = signalValue(item, 'subject') || item.label
  const unresolved = signalValue(item, 'unresolved_person')
  const observed = signalValue(item, 'observed_on')
  const score = item.store?.score_delta
  const relevance = item.store?.relevance
  return (
    <li className="review-signal">
      <label className="review-item__check">
        <input type="checkbox" checked={checked} disabled={locked} onChange={onToggle} />
        <span className="review-signal__kind">{SIGNAL_KIND_LABELS[kind] ?? kind}</span>
      </label>
      <div className="review-signal__main">
        <p className="review-signal__subject">
          {subject}
          {unresolved && <span className="review-signal__unresolved"> · personne non reconnue</span>}
        </p>
        <p className="review-signal__text">{shown(item.after)}</p>
        <p className="review-signal__meta">
          {observed && <span>{observed}</span>}
          {typeof score === 'number' && (
            <span className={score < 0 ? 'review-signal__score is-negative' : 'review-signal__score'}>
              {score > 0 ? '+' : ''}
              {String(score)}
            </span>
          )}
          {typeof relevance === 'number' && <span>pertinence {String(relevance)}</span>}
          {item.quote && <span>{item.quote}</span>}
        </p>
      </div>
      <ReviewEvidence item={item} showQuote={false} />
    </li>
  )
}

