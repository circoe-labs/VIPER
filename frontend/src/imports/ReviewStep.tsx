import { useMemo, useState } from 'react'

import type { CommitResult, PreviewResult } from '../api/imports'
import { Button } from '../ui/Button'
import { RefreshIcon } from '../ui/icons'
import { Tabs } from '../ui/Tabs'
import { CommitDialog } from './CommitDialog'
import { CATEGORY_LABELS, commitSummary, type RowCategory, rowCategory, rowIssues, type ReviewDecisions } from './importPlan'
import { codeLabel, plural, rowsText } from './messages'
import { ReimportWarning } from './ReimportWarning'
import { resolveCount, ResolvePanel } from './ResolvePanel'
import { RowsPanel } from './RowsPanel'

export type StatusFilter = 'all' | RowCategory | 'blocking'

export interface RowFilters {
  status: StatusFilter
  code: string | null
  search: string
}

export type Decide = (update: (decisions: ReviewDecisions) => ReviewDecisions) => void

interface ReviewStepProps {
  file: File
  preview: PreviewResult
  decisions: ReviewDecisions
  reanalyzing: boolean
  decide: Decide
  onReanalyse: (decisions?: ReviewDecisions) => void
  onCommitted: (result: CommitResult) => void
}

const TILES: { status: StatusFilter; label: string; tone: string }[] = [
  { status: 'all', label: 'Lignes', tone: 'neutral' },
  { status: 'valid', label: CATEGORY_LABELS.valid, tone: 'success' },
  { status: 'appointment', label: CATEGORY_LABELS.appointment, tone: 'info' },
  { status: 'ignored', label: CATEGORY_LABELS.ignored, tone: 'neutral' },
]

// Codes about the file or its columns are notices of the sheet step, not row filters.
const NOTICE_PREFIXES = ['file.', 'sheet.', 'column.', 'mapping.']
const SEVERITY_ORDER = { error: 0, warning: 1, info: 2 }

// The review: summary with filters, what to resolve (grouped by raw value) and the row table, then the commit.
export function ReviewStep({ file, preview, decisions, reanalyzing, decide, onReanalyse, onCommitted }: ReviewStepProps) {
  const review = preview.review
  const summary = review.preview.summary
  const [tab, setTab] = useState<'resolve' | 'rows'>('resolve')
  const [filters, setFilters] = useState<RowFilters>({ status: 'all', code: null, search: '' })
  const [openRow, setOpenRow] = useState<number | null>(null)
  const [confirming, setConfirming] = useState(false)
  const plan = useMemo(() => commitSummary(review, decisions), [review, decisions])
  const issues = useMemo(() => rowIssues(review, decisions), [review, decisions])
  const categories = useMemo(() => {
    const counts: Record<RowCategory, number> = { valid: 0, appointment: 0, ignored: 0 }
    for (const row of review.preview.rows) counts[rowCategory(review, decisions, row)] += 1
    return counts
  }, [review, decisions])
  const toResolve = resolveCount(review)

  const codes = useMemo(() => {
    const severity = new Map<string, keyof typeof SEVERITY_ORDER>()
    for (const row of review.preview.rows) for (const item of row.diagnostics) severity.set(item.code, item.severity)
    return Object.entries(summary.counts_by_code)
      .filter(([code]) => !NOTICE_PREFIXES.some((prefix) => code.startsWith(prefix)) && severity.has(code))
      .map(([code, count]) => ({ code, count, severity: severity.get(code) ?? 'info' }))
      .sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] || b.count - a.count)
  }, [review, summary.counts_by_code])

  function showRows(update: Partial<RowFilters>) {
    setFilters((current) => ({ ...current, ...update }))
    setTab('rows')
  }

  function tileCount(status: StatusFilter): number {
    if (status === 'all') return summary.rows_total
    if (status === 'blocking') return issues.size
    return categories[status]
  }

  return (
    <div className="import-review">
      <ReimportWarning previous={preview.previous_imports} />
      <section className="import-card import-summary" aria-labelledby="import-summary-title">
        <header className="import-summary__header">
          <div>
            <h2 id="import-summary-title" className="import-summary__title">
              Résumé de l’analyse
            </h2>
            <p className="import-muted">
              « {summary.file_name} » — feuille « {summary.sheet} ». Chaque ligne est classée : valide, RDV pris ou
              ignorée (profil trop incomplet ou plus en poste).
            </p>
          </div>
          <Button icon={RefreshIcon} loading={reanalyzing} onClick={() => { onReanalyse() }}>
            Relancer l’analyse
          </Button>
        </header>
        <div className="import-stats">
          {TILES.map((tile) => (
            <button
              key={tile.status}
              type="button"
              className="import-stat"
              data-tone={tile.tone}
              aria-pressed={tab === 'rows' && filters.status === tile.status}
              onClick={() => {
                showRows({ status: tile.status, code: null })
              }}
            >
              <span className="import-stat__value">{tileCount(tile.status)}</span>
              <span className="import-stat__label">{tile.label}</span>
            </button>
          ))}
        </div>
        {codes.length > 0 && (
          <div className="import-chips" role="group" aria-label="Filtrer les lignes par remarque">
            {codes.map(({ code, count, severity }) => (
              <button
                key={code}
                type="button"
                className="import-chip"
                data-severity={severity}
                aria-pressed={tab === 'rows' && filters.code === code}
                onClick={() => {
                  showRows({ code: filters.code === code && tab === 'rows' ? null : code, status: 'all' })
                }}
              >
                {codeLabel(code)}
                <span className="import-chip__count">{count}</span>
              </button>
            ))}
          </div>
        )}
      </section>

      <Tabs
        label="Vérification"
        className="import-review__tabs"
        selected={tab}
        onSelect={setTab}
        tabs={[
          { id: 'resolve', label: 'À résoudre', extra: <span className="import-tabs__count">{toResolve}</span> },
          { id: 'rows', label: 'Lignes', extra: <span className="import-tabs__count">{summary.rows_total}</span> },
        ]}
      >
        {tab === 'resolve' ? (
          <ResolvePanel
            review={review}
            decisions={decisions}
            issues={issues}
            decide={decide}
            onOpenRow={(row) => {
              setOpenRow(row)
              showRows({ status: 'all', code: null, search: '' })
            }}
          />
        ) : (
          <RowsPanel
            review={review}
            decisions={decisions}
            issues={issues}
            filters={filters}
            onFilters={setFilters}
            openRow={openRow}
            onOpenRow={setOpenRow}
            decide={decide}
            reanalyzing={reanalyzing}
            onReanalyse={onReanalyse}
          />
        )}
      </Tabs>

      <div className="import-actionbar" role="region" aria-label="Import">
        <p className="import-actionbar__summary" aria-live="polite">
          <strong>{rowsText(plan.imported)}</strong> à importer · {plural(plan.excluded, 'exclue', 'exclues')}
        </p>
        <Button
          variant="primary"
          disabled={issues.size > 0 || plan.imported === 0 || reanalyzing}
          onClick={() => {
            setConfirming(true)
          }}
        >
          Importer…
        </Button>
      </div>
      {confirming && (
        <CommitDialog
          file={file}
          preview={preview}
          decisions={decisions}
          summary={plan}
          onClose={() => {
            setConfirming(false)
          }}
          onReanalyse={() => {
            setConfirming(false)
            onReanalyse()
          }}
          onCommitted={onCommitted}
        />
      )}
    </div>
  )
}
