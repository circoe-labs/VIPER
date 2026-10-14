import { type ReactNode, useMemo, useState } from 'react'

import type { CommitResult, PreviewResult } from '../api/imports'
import { Button } from '../ui/Button'
import { ExportWorkbookButton } from '../exports/ExportWorkbookButton'
import {
  AlertIcon,
  BanIcon,
  CheckCircleIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  ClockIcon,
  type IconComponent,
  MailIcon,
  RefreshIcon,
  SpreadsheetIcon,
  UploadIcon,
} from '../ui/icons'
import { Tabs } from '../ui/Tabs'
import { CommitDialog } from './CommitDialog'
import { CATEGORY_LABELS, commitSummary, type RowCategory, rowCategory, rowIssues, type ReviewDecisions, sendMark } from './importPlan'
import { codeLabel, rowsText } from './messages'
import { ReimportWarning } from './ReimportWarning'
import { resolveCount, ResolvePanel } from './ResolvePanel'
import { RowsPanel } from './RowsPanel'

export type StatusFilter = 'all' | RowCategory | 'blocking' | 'r1' | 'r2' | 'sent'

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
  // The page's step bar, shown under the title, and « Nouvel import » (back to the file choice).
  stepper: ReactNode
  onReset: () => void
}

const KPIS: {
  key: 'all' | 'valid' | 'resolve' | 'importable'
  status: StatusFilter
  label: string
  tone: string
  icon: IconComponent
  percent: boolean
}[] = [
  { key: 'all', status: 'all', label: 'lignes détectées', tone: 'info', icon: SpreadsheetIcon, percent: false },
  { key: 'valid', status: 'valid', label: 'valides', tone: 'success', icon: CheckCircleIcon, percent: true },
  { key: 'resolve', status: 'blocking', label: 'à résoudre', tone: 'warning', icon: AlertIcon, percent: true },
  { key: 'importable', status: 'all', label: 'importables', tone: 'success', icon: UploadIcon, percent: true },
]
// The split bar: every row is in exactly one of these categories.
const SPLIT: { status: RowCategory; label: string; tone: string }[] = [
  { status: 'valid', label: CATEGORY_LABELS.valid, tone: 'success' },
  { status: 'appointment', label: CATEGORY_LABELS.appointment, tone: 'info' },
  { status: 'ignored', label: CATEGORY_LABELS.ignored, tone: 'danger' },
]
// The sending state of the cohort a row belongs to (same colours as the Home campaign pie), and the set-aside rows.
const STATUS_TILES: { status: StatusFilter; label: string; tone: string; icon: IconComponent }[] = [
  { status: 'r2', label: 'R2', tone: 'danger', icon: RefreshIcon },
  { status: 'r1', label: 'R1', tone: 'warning', icon: ClockIcon },
  { status: 'sent', label: 'Envoyés', tone: 'success', icon: MailIcon },
  { status: 'ignored', label: CATEGORY_LABELS.ignored, tone: 'neutral', icon: BanIcon },
]

// Codes about the file or its columns are notices of the sheet step, not row filters.
const NOTICE_PREFIXES = ['file.', 'sheet.', 'column.', 'mapping.']
// The remarks, grouped by what they are about (the code's prefix); anything else goes to « Autres ».
const REMARK_GROUPS: { label: string; prefixes: string[] }[] = [
  { label: 'Identité', prefixes: ['prospect.', 'civility.', 'duplicate.person'] },
  { label: 'Entreprise', prefixes: ['company.'] },
  { label: 'Catégorie et rôle', prefixes: ['category.', 'role.'] },
  { label: 'Référent', prefixes: ['referent.'] },
  { label: 'E-mails et téléphones', prefixes: ['email.', 'phone.', 'duplicate.email'] },
  { label: 'Cohorte et activité', prefixes: ['cohort.', 'activity.', 'tracking.'] },
]

function remarkGroup(code: string): string {
  return REMARK_GROUPS.find((group) => group.prefixes.some((prefix) => code.startsWith(prefix)))?.label ?? 'Autres'
}

const SEVERITY_ORDER = { error: 0, warning: 1, info: 2 }

// The review: summary with filters, what to resolve (grouped by raw value) and the row table, then the commit.
export function ReviewStep({ file, preview, decisions, reanalyzing, decide, onReanalyse, onCommitted, stepper, onReset }: ReviewStepProps) {
  const review = preview.review
  const summary = review.preview.summary
  const [tab, setTab] = useState<'resolve' | 'rows'>('resolve')
  const [filters, setFilters] = useState<RowFilters>({ status: 'all', code: null, search: '' })
  const [openRow, setOpenRow] = useState<number | null>(null)
  const [confirming, setConfirming] = useState(false)
  const [remarksOpen, setRemarksOpen] = useState(false)
  const plan = useMemo(() => commitSummary(review, decisions), [review, decisions])
  const issues = useMemo(() => rowIssues(review, decisions), [review, decisions])
  const categories = useMemo(() => {
    const counts: Record<RowCategory, number> = { valid: 0, appointment: 0, ignored: 0 }
    for (const row of review.preview.rows) counts[rowCategory(review, decisions, row)] += 1
    return counts
  }, [review, decisions])
  const marks = useMemo(() => {
    const counts = { r1: 0, r2: 0, sent: 0 }
    for (const row of review.preview.rows) {
      const label = sendMark(row)?.label
      if (label === 'R1') counts.r1 += 1
      else if (label === 'R2') counts.r2 += 1
      else if (label === 'Envoyé') counts.sent += 1
    }
    return counts
  }, [review])
  const toResolve = resolveCount(review)

  const codes = useMemo(() => {
    const severity = new Map<string, keyof typeof SEVERITY_ORDER>()
    for (const row of review.preview.rows) for (const item of row.diagnostics) severity.set(item.code, item.severity)
    return Object.entries(summary.counts_by_code)
      .filter(([code]) => !NOTICE_PREFIXES.some((prefix) => code.startsWith(prefix)) && severity.has(code))
      .map(([code, count]) => ({ code, count, severity: severity.get(code) ?? 'info' }))
      .sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] || b.count - a.count)
  }, [review, summary.counts_by_code])

  const remarkGroups = useMemo(() => {
    const groups = new Map<string, typeof codes>()
    for (const item of codes) groups.set(remarkGroup(item.code), [...(groups.get(remarkGroup(item.code)) ?? []), item])
    const order = [...REMARK_GROUPS.map((group) => group.label), 'Autres']
    return order.flatMap((label) => (groups.has(label) ? [{ label, items: groups.get(label) ?? [] }] : []))
  }, [codes])

  function showRows(update: Partial<RowFilters>) {
    setFilters((current) => ({ ...current, ...update }))
    setTab('rows')
  }

  function percent(count: number): string {
    return `${String(summary.rows_total ? Math.round((count / summary.rows_total) * 100) : 0)} %`
  }

  function kpiCount(key: (typeof KPIS)[number]['key']): number {
    if (key === 'all') return summary.rows_total
    if (key === 'valid') return categories.valid
    if (key === 'resolve') return toResolve
    return plan.imported
  }

  function tileCount(status: StatusFilter): number {
    if (status === 'all') return summary.rows_total
    if (status === 'blocking') return issues.size
    if (status === 'r1' || status === 'r2' || status === 'sent') return marks[status]
    return categories[status]
  }

  return (
    <div className="import-review">
      <header className="import-head">
        <div>
          <h1 className="import-head__title">Vérification de l’import</h1>
          <p className="import-head__file">
            <SpreadsheetIcon size={18} />
            <strong>{summary.file_name}</strong>
            <ChevronRightIcon size={14} />
            {summary.sheet}
            <span className="import-muted"> · {rowsText(summary.rows_total)} détectées</span>
          </p>
        </div>
        <div className="import-head__actions" role="region" aria-label="Import">
          <Button onClick={onReset}>Nouvel import</Button>
          <ExportWorkbookButton />
          <Button
            variant="primary"
            disabled={issues.size > 0 || plan.imported === 0 || reanalyzing}
            onClick={() => {
              setConfirming(true)
            }}
          >
            Importer {rowsText(plan.imported)}
          </Button>
        </div>
      </header>
      {stepper}
      <ReimportWarning previous={preview.previous_imports} />
      <section className="import-summary" aria-labelledby="import-summary-title">
        <h2 id="import-summary-title" className="visually-hidden">
          Résumé de l’analyse
        </h2>
        <div className="import-kpis">
          {KPIS.map((kpi) => {
            const count = kpiCount(kpi.key)
            const content = (
              <>
                <span className="import-kpi__icon">
                  <kpi.icon size={26} />
                </span>
                <span className="import-kpi__body">
                  <span className="import-kpi__value">{count}</span>
                  <span className="import-kpi__label">{kpi.label}</span>
                </span>
                {kpi.percent && <span className="import-kpi__percent">{percent(count)}</span>}
              </>
            )
            return kpi.key === 'importable' ? (
              <div key={kpi.key} className="import-kpi" data-tone={kpi.tone}>
                {content}
              </div>
            ) : (
              <button
                key={kpi.key}
                type="button"
                className="import-kpi"
                data-tone={kpi.tone}
                aria-pressed={kpi.key !== 'resolve' && tab === 'rows' && filters.status === kpi.status}
                onClick={() => {
                  if (kpi.key === 'resolve') setTab('resolve')
                  else showRows({ status: kpi.status, code: null })
                }}
              >
                {content}
              </button>
            )
          })}
        </div>
        <div className="import-panels">
          <section className="import-panel" aria-labelledby="import-split-title">
            <h3 id="import-split-title" className="import-panel__title">
              Répartition des lignes
            </h3>
            <div className="import-split" role="img" aria-label="Répartition des lignes par catégorie">
              {SPLIT.map((part) => (
                <span
                  key={part.status}
                  className="import-split__part"
                  data-tone={part.tone}
                  style={{ width: `${String(summary.rows_total ? (categories[part.status] / summary.rows_total) * 100 : 0)}%` }}
                />
              ))}
            </div>
            <ul className="import-split__legend">
              {SPLIT.map((part) => (
                <li key={part.status} data-tone={part.tone}>
                  <span className="import-split__swatch" aria-hidden="true" />
                  {percent(categories[part.status])} {part.label.toLowerCase()} <strong>{categories[part.status]}</strong>
                </li>
              ))}
            </ul>
          </section>
          <section className="import-panel" aria-labelledby="import-status-title">
            <h3 id="import-status-title" className="import-panel__title">
              Détail des statuts
            </h3>
            <div className="import-statuses">
              {STATUS_TILES.map((tile) => (
                <button
                  key={tile.status}
                  type="button"
                  className="import-status"
                  data-tone={tile.tone}
                  aria-pressed={tab === 'rows' && filters.status === tile.status}
                  onClick={() => {
                    showRows({ status: tile.status, code: null })
                  }}
                >
                  <span className="import-status__icon">
                    <tile.icon size={22} />
                  </span>
                  <span className="import-status__value">{tileCount(tile.status)}</span>
                  <span className="import-status__label">{tile.label}</span>
                  <span className="import-status__percent">{percent(tileCount(tile.status))}</span>
                </button>
              ))}
            </div>
          </section>
        </div>
        {codes.length > 0 && (
          <div className="import-remarks">
            <button
              type="button"
              className="import-remarks__toggle"
              aria-expanded={remarksOpen}
              aria-controls="import-remarks-panel"
              onClick={() => {
                setRemarksOpen((open) => !open)
              }}
            >
              {remarksOpen ? <ChevronDownIcon size={16} /> : <ChevronRightIcon size={16} />}
              Remarques
              <span className="import-chip__count">{codes.length}</span>
            </button>
            {remarksOpen && (
              <div id="import-remarks-panel" className="import-remarks__groups" role="group" aria-label="Filtrer les lignes par remarque">
                {remarkGroups.map((group) => (
                  <div key={group.label} className="import-remarks__group">
                    <span className="import-remarks__label">{group.label}</span>
                    <div className="import-chips">
                      {group.items.map(({ code, count, severity }) => (
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
                  </div>
                ))}
              </div>
            )}
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
