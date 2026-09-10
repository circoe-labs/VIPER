import { Fragment, useState } from 'react'

import type { ImportReview, PreviewRow } from '../api/imports'
import { foldText } from '../lib/text'
import { StatusBadge, type StatusTone } from '../ui/Badge'
import { Button } from '../ui/Button'
import { ChevronDownIcon, ChevronLeftIcon, ChevronRightIcon, CloseIcon } from '../ui/icons'
import { SearchField } from '../ui/SearchField'
import { Table } from '../ui/Table'
import { resolutionOf, type ReviewDecisions, type RowIssue } from './importPlan'
import { codeLabel, resolutionLabel, rowsText, STATUS_LABELS } from './messages'
import { personName } from './ResolutionChoice'
import type { Decide, RowFilters, StatusFilter } from './ReviewStep'
import { RowDetail } from './RowDetail'

const PAGE_SIZE = 25
const STATUS_FILTERS: { value: StatusFilter; label: string }[] = [
  { value: 'all', label: 'Toutes' },
  { value: 'error', label: 'En erreur' },
  { value: 'warning', label: 'À vérifier' },
  { value: 'ok', label: 'Sans remarque' },
  { value: 'excluded', label: 'Exclues' },
]
const STATUS_TONES: Record<PreviewRow['status'], StatusTone> = { ok: 'success', warning: 'warning', error: 'danger' }

interface RowsPanelProps {
  review: ImportReview
  decisions: ReviewDecisions
  issues: Map<number, RowIssue>
  filters: RowFilters
  onFilters: (filters: RowFilters) => void
  openRow: number | null
  onOpenRow: (row: number | null) => void
  decide: Decide
  reanalyzing: boolean
  onReanalyse: (decisions?: ReviewDecisions) => void
}

function searchable(row: PreviewRow): string {
  return foldText(
    [
      String(row.row_number),
      row.prospect.first_name,
      row.prospect.last_name,
      row.company?.display_name,
      ...row.emails.map((email) => email.address),
    ]
      .filter(Boolean)
      .join(' '),
  )
}

// Every analysed row, filterable by status, remark and text; a row opens on its proposal, remarks, duplicate
// candidates, preserved legacy values and the correction form.
export function RowsPanel(props: RowsPanelProps) {
  const { review, decisions, issues, filters, onFilters, openRow, onOpenRow } = props
  const query = foldText(filters.search.trim())
  const rows = review.preview.rows.filter((row) => {
    const resolution = resolutionOf(review, decisions, row.row_number)
    if (filters.status === 'excluded' && resolution.action !== 'exclude') return false
    if (filters.status === 'blocking' && !issues.has(row.row_number)) return false
    if (['ok', 'warning', 'error'].includes(filters.status) && row.status !== filters.status) return false
    if (filters.code && !row.diagnostics.some((item) => item.code === filters.code)) return false
    return !query || query.split(' ').every((word) => searchable(row).includes(word))
  })
  const [page, setPage] = useState(() => {
    const index = openRow === null ? -1 : rows.findIndex((row) => row.row_number === openRow)
    return index < 0 ? 0 : Math.floor(index / PAGE_SIZE)
  })
  const pages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE))
  const current = Math.min(page, pages - 1)
  const visible = rows.slice(current * PAGE_SIZE, (current + 1) * PAGE_SIZE)
  const update = (next: Partial<RowFilters>) => {
    onFilters({ ...filters, ...next })
    setPage(0)
  }

  return (
    <div className="import-rows">
      <div className="import-rows__toolbar">
        <SearchField
          label="Rechercher : ligne, nom, entreprise, e-mail"
          value={filters.search}
          onChange={(search) => {
            update({ search })
          }}
        />
        <fieldset className="segmented">
          <legend className="visually-hidden">Filtrer par statut</legend>
          {STATUS_FILTERS.map((option) => (
            <label key={option.value} className="segmented__option">
              <input
                type="radio"
                className="visually-hidden"
                name="import-row-status"
                value={option.value}
                checked={filters.status === option.value}
                onChange={() => {
                  update({ status: option.value })
                }}
              />
              {option.label}
            </label>
          ))}
        </fieldset>
        {filters.code && (
          <button
            type="button"
            className="import-chip"
            aria-pressed="true"
            onClick={() => {
              update({ code: null })
            }}
          >
            {codeLabel(filters.code)}
            <CloseIcon size={14} />
            <span className="visually-hidden">Retirer ce filtre</span>
          </button>
        )}
        <p className="import-rows__count" aria-live="polite">
          {rowsText(rows.length)}
        </p>
      </div>
      {rows.length === 0 ? (
        <p className="import-muted import-rows__empty">Aucune ligne ne correspond à ces filtres.</p>
      ) : (
        <Table caption="Lignes analysées">
          <thead>
            <tr>
              <th scope="col" className="table__numeric">
                Ligne
              </th>
              <th scope="col">Statut</th>
              <th scope="col">Prospect</th>
              <th scope="col">Entreprise</th>
              <th scope="col">E-mail</th>
              <th scope="col">Import</th>
              <th scope="col">
                <span className="visually-hidden">Détails</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {visible.map((row) => {
              const resolution = resolutionOf(review, decisions, row.row_number)
              const expanded = openRow === row.row_number
              const issue = issues.get(row.row_number)
              return (
                <Fragment key={row.row_number}>
                  <tr className="import-row" data-excluded={resolution.action === 'exclude' || undefined}>
                    <td className="table__numeric">{row.row_number}</td>
                    <td>
                      <StatusBadge tone={STATUS_TONES[row.status]}>{STATUS_LABELS[row.status]}</StatusBadge>
                    </td>
                    <td>
                      <span className="import-row__name">{personName(row)}</span>
                      {row.prospect.exact_job_title && (
                        <span className="import-muted">{row.prospect.exact_job_title}</span>
                      )}
                    </td>
                    <td>{row.company?.display_name ?? '—'}</td>
                    <td className="import-row__email">{row.emails[0]?.address ?? '—'}</td>
                    <td>
                      {issue ? (
                        <StatusBadge tone="danger">À résoudre</StatusBadge>
                      ) : (
                        <span className="import-row__resolution">{resolutionLabel(resolution)}</span>
                      )}
                    </td>
                    <td>
                      <Button
                        size="sm"
                        variant="ghost"
                        icon={ChevronDownIcon}
                        aria-expanded={expanded}
                        aria-controls={`import-row-${String(row.row_number)}`}
                        aria-label={`${expanded ? 'Fermer' : 'Détails'} de la ligne ${String(row.row_number)}`}
                        onClick={() => {
                          onOpenRow(expanded ? null : row.row_number)
                        }}
                      >
                        {expanded ? 'Fermer' : 'Détails'}
                      </Button>
                    </td>
                  </tr>
                  {expanded && (
                    <tr className="import-row__detail">
                      <td colSpan={7} id={`import-row-${String(row.row_number)}`}>
                        <RowDetail {...props} row={row} issue={issue ?? null} />
                      </td>
                    </tr>
                  )}
                </Fragment>
              )
            })}
          </tbody>
        </Table>
      )}
      {pages > 1 && (
        <nav className="import-rows__pager" aria-label="Pages des lignes">
          <span>
            {current * PAGE_SIZE + 1}–{Math.min((current + 1) * PAGE_SIZE, rows.length)} sur {rows.length}
          </span>
          <Button
            size="sm"
            icon={ChevronLeftIcon}
            disabled={current === 0}
            onClick={() => {
              setPage(current - 1)
            }}
          >
            Précédentes
          </Button>
          <Button
            size="sm"
            icon={ChevronRightIcon}
            disabled={current >= pages - 1}
            onClick={() => {
              setPage(current + 1)
            }}
          >
            Suivantes
          </Button>
        </nav>
      )}
    </div>
  )
}
