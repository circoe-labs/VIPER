import type { ProposalItem } from '../api/agents'
import { ReviewEvidence } from './ReviewEvidence'
import { SIGNAL_KIND_LABELS } from './labels'
import { ConfidenceBadge } from './ReviewConfidence'
import { formatSourceDate, safeHref, sourceLabel } from './reviewFormat'
import { StatusBadge } from '../ui/Badge'
import { Table } from '../ui/Table'

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
export interface RawEvidence {
  field: string
  source?: string | null
  quote?: string | null
  confidence?: number | null
  source_published_at?: string | null
  source_checked_at?: string | null
}

// The evidence the agent gave for one discovered company, read from the raw result (`companies[index].evidence`).
export function companyEvidence(raw: Record<string, unknown>, item: ProposalItem): RawEvidence[] {
  const index = /^company:(\d+):/.exec(item.key)?.[1]
  const companies = raw.companies
  if (index === undefined || !Array.isArray(companies)) return []
  const company: unknown = companies[Number(index)]
  const evidence = isRecord(company) ? company.evidence : null
  return Array.isArray(evidence) ? evidence.filter(isRecord).map((entry) => entry as unknown as RawEvidence) : []
}

const COMPANY_FIELDS: [string, string][] = [
  ['display_name', 'Nom'], ['legal_name', 'Raison sociale'], ['siren', 'SIREN'], ['website_url', 'Site web'],
  ['email_domain', 'Domaine e-mail'], ['size_label', 'Effectif'],
]

// What accepting does about warehouses (`warehouses_to_create` and `site.warehouse`, computed by the server while the
// result awaits a decision).
function SiteOutcome({ plan }: { plan: unknown }) {
  if (!isRecord(plan)) return null
  const action = textOf(plan, 'action')
  if (action === 'create') return <StatusBadge tone="success">Entrepôt à créer</StatusBadge>
  if (action === 'duplicate') return <StatusBadge tone="warning">Entrepôt déjà enregistré : {textOf(plan, 'existing_name')}</StatusBadge>
  if (action === 'known_site') return <StatusBadge tone="neutral">Site déjà connu, non recréé</StatusBadge>
  return <StatusBadge tone="neutral">Établissement seul</StatusBadge>
}

function CreationSummary({ count }: { count: unknown }) {
  if (typeof count !== 'number') return null
  const label = count === 0 ? 'Société, sans fiche entrepôt' : `Société + ${String(count)} fiche${count > 1 ? 's' : ''} entrepôt`
  return (
    <p className="review-discovery__creation">
      Sera créé : <StatusBadge tone={count === 0 ? 'warning' : 'success'}>{label}</StatusBadge>
    </p>
  )
}

// New company as a field table: one row per datum (value, source, confidence, dates), so the reviewer sees where each
// piece comes from. A field without its own evidence falls back to the company's main source.
function CompanyFieldTable({ item, evidence }: { item: ProposalItem; evidence: RawEvidence[] }) {
  const store = item.store ?? {}
  const rows = COMPANY_FIELDS.map(([key, label]) => ({ key, label, value: textOf(store, key) })).filter((row) => row.value)
  const known = new Set(rows.map((row) => row.key))
  const extra = evidence.filter((entry) => !known.has(entry.field))
  const own = (key: string) => evidence.find((entry) => entry.field === key)
  const fallback: RawEvidence = { field: '', source: item.source, quote: item.quote, confidence: item.confidence, source_published_at: item.source_published_at, source_checked_at: item.source_checked_at }
  const line = (key: string, label: string, value: string, entry: RawEvidence | undefined) => {
    const used = entry ?? fallback
    const href = used.source ? safeHref(used.source) : null
    return (
      <tr key={key}>
        <th scope="row" data-label="Champ">{label}</th>
        <td data-label="Valeur">{value}</td>
        <td data-label="Source">
          {href ? <SourceLink href={href} /> : <span className="rvt-missing">aucune source</span>}
          {entry === undefined && href && <small className="review-discovery__reason"> (source de la société)</small>}
        </td>
        <td data-label="Confiance"><ConfidenceBadge value={used.confidence} compact /></td>
        <td data-label="Publiée">{used.source_published_at ? formatSourceDate(used.source_published_at) : <span className="rvt-missing">inconnue</span>}</td>
        <td data-label="Vérifiée">{used.source_checked_at ? formatSourceDate(used.source_checked_at, true) : <span className="rvt-missing">non datée</span>}</td>
      </tr>
    )
  }
  if (rows.length === 0 && extra.length === 0) return null
  return (
    <div className="rvt review-discovery__fields">
      <Table caption="Informations de la société" density="compact">
        <thead>
          <tr><th scope="col">Champ</th><th scope="col">Valeur</th><th scope="col">Source</th><th scope="col">Confiance</th><th scope="col">Publiée</th><th scope="col">Vérifiée</th></tr>
        </thead>
        <tbody>
          {rows.map((row) => line(row.key, row.label, row.value, own(row.key)))}
          {extra.map((entry, index) => line(`extra-${String(index)}`, entry.field, entry.quote ?? '—', entry))}
        </tbody>
      </Table>
    </div>
  )
}

export function DiscoveryDetails({ item, evidence = [] }: { item: ProposalItem; evidence?: RawEvidence[] }) {
  const rawSites = item.store?.establishments
  const sites = Array.isArray(rawSites) ? rawSites.filter(isRecord) : []
  const trigger = isRecord(item.store?.trigger) ? item.store.trigger : null
  const hasFields = COMPANY_FIELDS.some(([key]) => textOf(item.store ?? {}, key)) || evidence.length > 0
  if (sites.length === 0 && !trigger && !hasFields) return null
  const kind = trigger ? textOf(trigger, 'kind') : ''
  const score = trigger?.score_delta
  return (
    <div className="review-discovery">
      <CreationSummary count={item.store?.warehouses_to_create} />
      <CompanyFieldTable item={item} evidence={evidence} />
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
                <SiteOutcome plan={site.warehouse} />
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

