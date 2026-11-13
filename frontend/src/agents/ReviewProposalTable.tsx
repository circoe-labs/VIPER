import type { ReactNode } from 'react'

import type { ProposalItem } from '../api/agents'
import { StatusBadge } from '../ui/Badge'
import { Table } from '../ui/Table'
import { ConfidenceBadge } from './ReviewConfidence'
import { shown } from './ReviewItems'
import { formatSourceDate, isOldSource, safeHref, sourceHost } from './reviewFormat'
import './reviewTable.css'

interface ReviewProposalTableProps {
  items: ProposalItem[]
  selected: ReadonlySet<string>
  // Decided results are shown as they were decided: no checkbox can change.
  locked: boolean
  onToggle: (key: string) => void
  // Extra detail rendered under a row (discovered company sites, trigger...), spanning every column.
  detail?: (item: ProposalItem) => ReactNode
}

function SourceCell({ item }: { item: ProposalItem }) {
  const href = safeHref(item.source)
  if (!href) return <span className="rvt-missing">aucune source</span>
  return (
    <>
      <a href={href} target="_blank" rel="noreferrer noopener" title={href}>
        source
      </a>{' '}
      <span className="rvt-host">{sourceHost(href)}</span>
    </>
  )
}

function PublishedCell({ value }: { value: string | null }) {
  if (!value) return <span className="rvt-missing">inconnue</span>
  return (
    <>
      <time dateTime={value}>{formatSourceDate(value)}</time>
      {isOldSource(value) && (
        <>
          {' '}
          <StatusBadge tone="warning">ancienne</StatusBadge>
        </>
      )}
    </>
  )
}

// The proposal as a table (Champ / Avant / Proposé / Confiance / Source / Publiée / Vérifiée), one selectable row per
// proposed value. Selection semantics belong to the dialog: this component only renders `selected` and reports
// toggles. Every missing fact is said out loud (historical results carry no confidence or dates); the publication date
// is never replaced by the check date. Below 40rem each row stacks as labelled lines (`data-label`).
export function ReviewProposalTable({ items, selected, locked, onToggle, detail }: ReviewProposalTableProps) {
  return (
    <div className="rvt">
      <Table caption="Propositions" density="compact">
        <thead>
          <tr>
            <th scope="col" className="rvt-check">
              <span className="visually-hidden">Retenir</span>
            </th>
            <th scope="col">Champ</th>
            <th scope="col">Avant</th>
            <th scope="col">Proposé</th>
            <th scope="col">Confiance</th>
            <th scope="col">Source</th>
            <th scope="col">Publiée</th>
            <th scope="col">Vérifiée</th>
          </tr>
        </thead>
        <tbody>
          {items.map((item) => {
            const checked = selected.has(item.key)
            const extra = detail?.(item)
            return (
              <RowGroup key={item.key} quote={item.quote} extra={extra}>
                <tr className={`rvt-row${checked ? ' is-selected' : ''}`}>
                  <td className="rvt-check">
                    <input
                      type="checkbox"
                      aria-label={item.label}
                      checked={checked}
                      disabled={locked}
                      onChange={() => {
                        onToggle(item.key)
                      }}
                    />
                  </td>
                  <th scope="row" className="rvt-field" data-label="Champ">
                    {item.label}
                  </th>
                  <td className="rvt-before" data-label="Avant">
                    {shown(item.before)}
                  </td>
                  <td className={`rvt-after rvt-after--${item.status}`} data-label="Proposé">
                    {shown(item.after)}
                  </td>
                  <td data-label="Confiance">
                    <ConfidenceBadge value={item.confidence} compact />
                  </td>
                  <td data-label="Source">
                    <SourceCell item={item} />
                  </td>
                  <td data-label="Publiée">
                    <PublishedCell value={item.source_published_at ?? null} />
                  </td>
                  <td data-label="Vérifiée">
                    {item.source_checked_at ? (
                      <time dateTime={item.source_checked_at}>{formatSourceDate(item.source_checked_at, true)}</time>
                    ) : (
                      <span className="rvt-missing">non datée</span>
                    )}
                  </td>
                </tr>
              </RowGroup>
            )
          })}
        </tbody>
      </Table>
    </div>
  )
}

// A row, plus an optional full-width detail row (agent quote, discovery details) kept visually attached to it.
function RowGroup({ children, quote, extra }: { children: ReactNode; quote: string | null; extra: ReactNode }) {
  return (
    <>
      {children}
      {quote || extra ? (
        <tr className="rvt-detail">
          <td colSpan={8}>
            {quote && <q className="rvt-quote">{quote}</q>}
            {extra}
          </td>
        </tr>
      ) : null}
    </>
  )
}
