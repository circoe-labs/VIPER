import { useQueryClient } from '@tanstack/react-query'
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react'
import { Link, useNavigate } from 'react-router'

import { ApiError } from '../api/client'
import {
  changeErrors,
  type ExplorerColumn,
  type ExplorerRow,
  type ExplorerTable,
  explorerKeys,
  exportUrl,
  saveChanges,
  useExplorerRows,
  useExplorerTable,
} from '../api/explorer'
import { Badge, StatusBadge } from '../ui/Badge'
import { Button, IconButton } from '../ui/Button'
import { EmptyState } from '../ui/EmptyState'
import {
  AlertIcon,
  ArrowLeftIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  CloseIcon,
  ColumnsIcon,
  DownloadIcon,
  FilterIcon,
  InfoIcon,
  LockIcon,
  PlusIcon,
  RefreshIcon,
  SearchIcon,
  TableIcon,
  TrashIcon,
} from '../ui/icons'
import { Popover } from '../ui/Popover'
import { clipboardValue } from './cells'
import { ColumnsPanel } from './ColumnsPanel'
import {
  type ColumnAction,
  type ColumnState,
  columnStateReducer,
  loadColumnState,
  saveColumnState,
} from './columnState'
import { DeleteRowsDialog } from './DeleteRowsDialog'
import { cellEditability } from './editing'
import { ExplorerGrid, type CellPosition, type GridEditing, type RowMeta } from './ExplorerGrid'
import { type ColumnFilter, type ExplorerView, PAGE_SIZES, type SortKey, toRowsQuery } from './explorerView'
import { describeFilter } from './filters'
import type { NavigationOrigin } from './navigation'
import { PendingChangesBar, PendingChangesDrawer, summaryTitle } from './PendingChanges'
import {
  EMPTY_STAGING,
  errorCount,
  errorsById,
  isDirty,
  newRowId,
  rowId,
  rowStatus,
  type SourceRow,
  sourceRow,
  stagedValues,
  stagingReducer,
  summarize,
  toChangeSet,
} from './staging'
import { tableLabel } from './tableCatalog'
import { TableStructure } from './TableStructure'
import { UnsavedChangesGuard } from './UnsavedChangesGuard'
import { ValueViewer } from './ValueViewer'

const COUNT = new Intl.NumberFormat('fr-FR')
const SEARCH_DELAY_MS = 300
const STATUS_DURATION_MS = 3000
const NO_SELECTION: ReadonlySet<string> = new Set()

interface TableWorkspaceProps {
  table: string
  view: ExplorerView
  onViewChange: (patch: Partial<ExplorerView>) => void
  origin: NavigationOrigin | null
}

// Column layout for one table: loaded from localStorage once the columns are known, saved on every change.
function useColumnState(table: string, columns: ExplorerColumn[] | undefined) {
  const initial = useMemo(() => (columns ? loadColumnState(table, columns) : null), [table, columns])
  const [changed, setChanged] = useState<ColumnState | null>(null)
  const state = changed ?? initial
  const dispatch = useCallback(
    (action: ColumnAction) => {
      if (!state) return
      const next = columnStateReducer(state, action)
      setChanged(next)
      saveColumnState(table, next)
    },
    [state, table],
  )
  return [state, dispatch] as const
}

export function TableWorkspace({ table, view, onViewChange, origin }: TableWorkspaceProps) {
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const meta = useExplorerTable(table)
  const query = useMemo(() => toRowsQuery(view), [view])
  const rows = useExplorerRows(table, query, meta.isSuccess)
  const [columnState, dispatch] = useColumnState(table, meta.data?.columns)

  if (meta.isPending) {
    return (
      <section className="explorer-workspace explorer-workspace--center" aria-busy="true">
        <p className="explorer-workspace__loading">Chargement de {table}…</p>
      </section>
    )
  }
  if (meta.isError || !columnState) {
    const missing = meta.error instanceof ApiError && meta.error.status === 404
    return (
      <section className="explorer-workspace explorer-workspace--center">
        <EmptyState
          icon={AlertIcon}
          title={missing ? 'Table introuvable' : 'Impossible de charger la table'}
          description={
            missing
              ? `« ${table} » n’existe pas ou n’est pas exposée dans l’explorateur.`
              : 'Le serveur n’a pas répondu. Vérifiez la connexion à l’API puis réessayez.'
          }
          action={
            missing ? (
              <Link to="/database">Retour aux tables</Link>
            ) : (
              <Button
                onClick={() => {
                  void meta.refetch()
                }}
              >
                Réessayer
              </Button>
            )
          }
        />
      </section>
    )
  }

  return (
    <Workspace
      meta={meta.data}
      view={view}
      onViewChange={onViewChange}
      origin={origin}
      rows={rows}
      columnState={columnState}
      onColumnAction={dispatch}
      onRefresh={() => {
        void queryClient.invalidateQueries({ queryKey: explorerKeys.all })
      }}
      onNavigate={(href) => {
        void navigate(href, { state: { origin: { table } satisfies NavigationOrigin } })
      }}
    />
  )
}

interface WorkspaceProps {
  meta: ExplorerTable
  view: ExplorerView
  onViewChange: (patch: Partial<ExplorerView>) => void
  origin: NavigationOrigin | null
  rows: ReturnType<typeof useExplorerRows>
  columnState: ColumnState
  onColumnAction: (action: ColumnAction) => void
  onRefresh: () => void
  onNavigate: (href: string) => void
}

// A displayed existing row: the page row as read (`source`) and as shown with its staged values (`row`).
interface ShownRow {
  id: string
  source: ExplorerRow
  row: ExplorerRow
}

function Workspace({ meta, view, onViewChange, origin, rows, columnState, onColumnAction, onRefresh, onNavigate }: WorkspaceProps) {
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const [searchText, setSearchText] = useState(view.search)
  const [status, setStatus] = useState('')
  const [activeCell, setActiveCell] = useState<CellPosition | null>(null)
  const [viewing, setViewing] = useState<CellPosition | null>(null)
  const [structureOpen, setStructureOpen] = useState(false)
  const [columnsAnchor, setColumnsAnchor] = useState<HTMLElement | null>(null)
  const [staging, dispatchStaging] = useReducer(stagingReducer, EMPTY_STAGING)
  // Selection belongs to the page it was made on: another page, filter or sort starts empty.
  const pageKey = JSON.stringify(toRowsQuery(view))
  const [selection, setSelection] = useState<{ page: string; ids: ReadonlySet<string> }>({ page: pageKey, ids: NO_SELECTION })
  const [deleting, setDeleting] = useState<SourceRow[] | null>(null)
  const [reviewing, setReviewing] = useState(false)
  const [saving, setSaving] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)
  const [editRequest, setEditRequest] = useState<{ row: string; column: string } | null>(null)
  const statusTimer = useRef<number>(undefined)

  useEffect(() => {
    const timer = window.setTimeout(() => {
      if (searchText.trim() !== view.search) onViewChange({ search: searchText.trim(), page: 1 })
    }, SEARCH_DELAY_MS)
    return () => {
      window.clearTimeout(timer)
    }
  }, [searchText, view.search, onViewChange])

  useEffect(() => () => {
    window.clearTimeout(statusTimer.current)
  }, [])

  const announce = useCallback((message: string) => {
    setStatus(message)
    window.clearTimeout(statusTimer.current)
    statusTimer.current = window.setTimeout(() => {
      setStatus('')
    }, STATUS_DURATION_MS)
  }, [])

  const copy = useCallback(
    (text: string, message: string) => {
      navigator.clipboard.writeText(text).then(
        () => {
          announce(message)
        },
        () => {
          announce('Copie impossible : le navigateur refuse l’accès au presse-papiers.')
        },
      )
    },
    [announce],
  )

  const page = rows.data
  const pageRows = page?.rows ?? []
  const total = page?.total ?? 0
  const pageCount = Math.max(1, Math.ceil(total / view.pageSize))
  const firstRowNumber = (view.page - 1) * view.pageSize + 1
  const hasCriteria = view.filters.length > 0 || view.search !== ''
  const label = tableLabel(meta.name)
  const byName = new Map(meta.columns.map((column) => [column.name, column]))
  const summary = summarize(staging)
  const dirty = isDirty(staging)
  const selected = selection.page === pageKey ? selection.ids : NO_SELECTION
  const readOnly = meta.update_refused !== null && meta.insert_refused !== null && meta.delete_refused !== null

  // Staged values shown over the page rows; new rows first.
  const shown: ShownRow[] = pageRows.map((source) => {
    const id = rowId(meta.primary_key, source.values)
    const values = stagedValues(staging, id)
    if (!values) return { id, source, row: source }
    return {
      id,
      source,
      row: { values: { ...source.values, ...values }, truncated: source.truncated.filter((name) => !(name in values)) },
    }
  })
  const displayRows: ExplorerRow[] = [
    ...staging.inserts.map((insert) => ({ values: insert.values, truncated: [] })),
    ...shown.map((item) => item.row),
  ]
  const rowMetas: RowMeta[] = [
    ...staging.inserts.map(
      (insert): RowMeta => ({ id: insert.id, status: 'new', number: null, staged: new Map(), errors: staging.errors[insert.id] ?? [] }),
    ),
    ...shown.map((item, index): RowMeta => {
      const update = staging.updates.find((entry) => entry.id === item.id)
      return {
        id: item.id,
        status: rowStatus(staging, item.id),
        number: firstRowNumber + index,
        staged: new Map(Object.keys(update?.values ?? {}).map((name) => [name, update?.original[name]])),
        errors: staging.errors[item.id] ?? [],
      }
    }),
  ]
  const newCount = staging.inserts.length
  const sourceOf = (index: number): SourceRow | null => {
    const item = shown[index - newCount]
    return item ? sourceRow(meta, item.source.values) : null
  }

  const editing: GridEditing = {
    rows: rowMetas,
    editability: (index, column) => cellEditability(meta, column, rowMetas[index]?.status ?? null),
    edit: (index, column, value) => {
      const target = rowMetas[index]
      const source = sourceOf(index)
      if (target?.status === 'new') dispatchStaging({ type: 'editNew', id: target.id, column, value })
      else if (source) dispatchStaging({ type: 'edit', row: source, column, value })
    },
    revertCell: (index, column) => {
      const target = rowMetas[index]
      if (target) dispatchStaging({ type: 'revertCell', id: target.id, column })
    },
    deleteRows: (indexes) => {
      for (const index of indexes) {
        const target = rowMetas[index]
        if (target?.status === 'new') dispatchStaging({ type: 'revert', id: target.id })
      }
      const existing = indexes.flatMap((index) => (rowMetas[index]?.status === 'new' ? [] : [sourceOf(index)])).filter((row) => row !== null)
      if (existing.length > 0) setDeleting(existing)
    },
    restoreRow: (index) => {
      const target = rowMetas[index]
      if (target) dispatchStaging({ type: 'revert', id: target.id })
    },
    canDelete: meta.delete_refused === null,
    bulk: meta.bulk_delete,
    selected,
    toggleSelected: (index, additive) => {
      const id = rowMetas[index]?.id
      if (!id) return
      const next = new Set(additive && meta.bulk_delete ? selected : [])
      if (selected.has(id)) next.delete(id)
      else next.add(id)
      setSelection({ page: pageKey, ids: next })
    },
  }

  function addRow() {
    const id = newRowId(staging)
    dispatchStaging({ type: 'addRow' })
    const first = meta.columns.find((column) => column.required_on_insert) ?? meta.columns.find((column) => column.insertable)
    if (first) setEditRequest({ row: id, column: first.name })
    announce('Nouvelle ligne ajoutée en haut du tableau ; elle sera créée à l’enregistrement.')
  }

  function discard() {
    dispatchStaging({ type: 'clear' })
    setFailure(null)
    announce('Modifications annulées : les valeurs d’origine sont rétablies.')
  }

  async function save() {
    const request = toChangeSet(staging)
    setSaving(true)
    setFailure(null)
    try {
      const result = await saveChanges(meta.name, request.changes)
      dispatchStaging({ type: 'clear' })
      setSelection({ page: pageKey, ids: NO_SELECTION })
      setReviewing(false)
      announce(`${String(result.updated + result.inserted + result.deleted)} ligne(s) enregistrée(s) et inscrite(s) au journal d’audit.`)
      await queryClient.invalidateQueries({ queryKey: explorerKeys.all })
    } catch (error) {
      const errors = error instanceof ApiError ? changeErrors(error.detail) : null
      if (errors) {
        dispatchStaging({ type: 'setErrors', errors: errorsById(request.ids, errors) })
        announce('Enregistrement refusé : rien n’a été enregistré.')
      } else {
        setFailure('Le serveur n’a pas répondu ou a refusé la requête.')
      }
    } finally {
      setSaving(false)
    }
  }

  const viewedColumn = viewing ? byName.get(viewing.column) : undefined
  const viewedRow = viewing ? displayRows[viewing.row] : undefined
  const viewedNumber = viewing ? rowMetas[viewing.row]?.number : undefined
  const activeRow = activeCell ? displayRows[activeCell.row] : undefined
  const activeNumber = activeCell ? rowMetas[activeCell.row]?.number : undefined

  function clearCriteria() {
    setSearchText('')
    onViewChange({ filters: [], search: '', page: 1 })
  }

  function setFilters(filters: ColumnFilter[]) {
    onViewChange({ filters, page: 1 })
  }

  function setSort(sort: SortKey[]) {
    onViewChange({ sort, page: 1 })
  }

  const exportHref = exportUrl(meta.name, { filter: toRowsQuery(view).filter, search: view.search, sort: toRowsQuery(view).sort })
  const selectedRows = rowMetas.flatMap((row, index) => (selected.has(row.id) ? [index] : []))

  let empty = <p>Cette table est vide.</p>
  if (rows.isError) {
    const invalid = rows.error instanceof ApiError && rows.error.status === 422
    empty = (
      <EmptyState
        icon={AlertIcon}
        title={invalid ? 'Filtre ou tri invalide' : 'Impossible de charger les lignes'}
        description={invalid ? 'Un critère ne correspond plus aux colonnes de la table.' : 'Le serveur n’a pas répondu.'}
        action={
          invalid ? (
            <Button onClick={clearCriteria}>Effacer les filtres</Button>
          ) : (
            <Button onClick={onRefresh}>Réessayer</Button>
          )
        }
      />
    )
  } else if (rows.isPending) {
    empty = <p>Chargement des lignes…</p>
  } else if (total > 0) {
    empty = (
      <p>
        Cette page est au-delà des résultats.{' '}
        <button type="button" className="explorer-link" onClick={() => { onViewChange({ page: 1 }) }}>
          Revenir à la première page
        </button>
      </p>
    )
  } else if (hasCriteria) {
    empty = (
      <p>
        Aucune ligne ne correspond aux critères.{' '}
        <button type="button" className="explorer-link" onClick={clearCriteria}>
          Effacer les filtres
        </button>
      </p>
    )
  }

  return (
    <section className="explorer-workspace" aria-labelledby="explorer-table-title">
      <header className="explorer-toolbar" data-can-insert={meta.insert_refused === null ? '' : undefined}>
        <div className="explorer-toolbar__identity">
          {origin && (
            <Button
              variant="ghost"
              size="sm"
              icon={ArrowLeftIcon}
              className="explorer-toolbar__back"
              onClick={() => {
                void navigate(-1)
              }}
            >
              Retour à {origin.table}
            </Button>
          )}
          <div className="explorer-toolbar__title-row">
            <TableIcon size={20} className="explorer-toolbar__icon" />
            <h2 id="explorer-table-title" className="explorer-toolbar__title">
              {meta.name}
            </h2>
            {label && <span className="explorer-toolbar__label">{label}</span>}
            <Badge>{COUNT.format(meta.row_count)} lignes</Badge>
            {readOnly && (
              <span title={meta.update_refused ?? undefined}>
                <StatusBadge tone="neutral" icon={LockIcon}>
                  Lecture seule
                </StatusBadge>
              </span>
            )}
          </div>
        </div>
        <div className="explorer-toolbar__actions">
          <label className="explorer-search explorer-toolbar__search">
            <SearchIcon size={16} />
            <span className="visually-hidden">Rechercher dans {meta.name}</span>
            <input
              type="search"
              placeholder="Rechercher…"
              value={searchText}
              onChange={(event) => {
                setSearchText(event.target.value)
              }}
            />
          </label>
          {meta.insert_refused === null && (
            <Button
              size="sm"
              icon={PlusIcon}
              className="explorer-toolbar__button explorer-toolbar__add"
              title="Ajouter une ligne"
              onClick={addRow}
            >
              <span className="explorer-toolbar__text">Ajouter une ligne</span>
            </Button>
          )}
          {selectedRows.length > 0 && (
            <Button
              size="sm"
              variant="danger"
              icon={TrashIcon}
              className="explorer-toolbar__button"
              title="Supprimer les lignes sélectionnées"
              onClick={() => {
                editing.deleteRows(selectedRows)
              }}
            >
              <span className="explorer-toolbar__text">Supprimer ({selectedRows.length})</span>
            </Button>
          )}
          {/* Labels collapse to icons (tooltip + accessible name kept) when the workspace is narrow. */}
          <Button
            size="sm"
            icon={ColumnsIcon}
            className="explorer-toolbar__button"
            title="Colonnes"
            aria-haspopup="dialog"
            aria-expanded={columnsAnchor !== null}
            onClick={(event) => {
              setColumnsAnchor(columnsAnchor ? null : event.currentTarget)
            }}
          >
            <span className="explorer-toolbar__text">Colonnes</span>
          </Button>
          <Button
            size="sm"
            icon={InfoIcon}
            className="explorer-toolbar__button"
            title="Structure de la table"
            onClick={() => {
              setStructureOpen(true)
            }}
          >
            <span className="explorer-toolbar__text">Structure</span>
          </Button>
          <a
            className="btn btn--secondary btn--sm explorer-toolbar__button"
            href={exportHref}
            title="Exporter les lignes filtrées en CSV"
            download
          >
            <DownloadIcon size={16} />
            <span className="explorer-toolbar__text">Exporter CSV</span>
          </a>
          <IconButton
            icon={RefreshIcon}
            variant="secondary"
            size="sm"
            label="Actualiser"
            loading={rows.isFetching}
            onClick={onRefresh}
          />
        </div>
      </header>

      {hasCriteria && (
        <div className="explorer-criteria" aria-label="Critères actifs" role="group">
          <FilterIcon size={16} className="explorer-criteria__icon" />
          {view.search && (
            <span className="filter-chip">
              Recherche « {view.search} »
              <IconButton
                icon={CloseIcon}
                size="sm"
                label="Retirer la recherche"
                onClick={() => {
                  setSearchText('')
                  onViewChange({ search: '', page: 1 })
                }}
              />
            </span>
          )}
          {view.filters.map((filter, index) => (
            <span key={`${filter.column}-${String(index)}`} className="filter-chip">
              {describeFilter(filter, byName.get(filter.column))}
              <IconButton
                icon={CloseIcon}
                size="sm"
                label={`Retirer le filtre : ${describeFilter(filter, byName.get(filter.column))}`}
                onClick={() => {
                  setFilters(view.filters.filter((_, position) => position !== index))
                }}
              />
            </span>
          ))}
          <Button variant="ghost" size="sm" onClick={clearCriteria}>
            Effacer les filtres
          </Button>
        </div>
      )}

      {dirty && (
        <PendingChangesBar
          summary={summary}
          errors={errorCount(staging)}
          failure={failure}
          saving={saving}
          onReview={() => {
            setReviewing(true)
          }}
          onCancel={discard}
          onSave={() => {
            void save()
          }}
        />
      )}

      <ExplorerGrid
        meta={meta}
        rows={displayRows}
        editing={editing}
        firstRowNumber={firstRowNumber}
        total={total}
        columnState={columnState}
        onColumnAction={onColumnAction}
        sort={view.sort}
        onSortChange={setSort}
        filters={view.filters}
        onAddFilter={(filter) => {
          setFilters([...view.filters, filter])
        }}
        onRemoveFilter={(index) => {
          setFilters(view.filters.filter((_, position) => position !== index))
        }}
        onViewValue={setViewing}
        onNavigate={onNavigate}
        onCopy={copy}
        onAnnounce={announce}
        onActiveCellChange={setActiveCell}
        editRequest={editRequest}
        onEditRequestDone={() => {
          setEditRequest(null)
        }}
        busy={rows.isFetching}
        empty={empty}
      />

      <footer className="explorer-status">
        <div className="explorer-status__paging">
          <span className="explorer-status__range">
            {total === 0
              ? '0 ligne'
              : `Lignes ${COUNT.format(Math.min(firstRowNumber, total))}–${COUNT.format(Math.min(firstRowNumber + pageRows.length - 1, total))} sur ${COUNT.format(total)}`}
            {hasCriteria && total !== meta.row_count && ` (filtrées parmi ${COUNT.format(meta.row_count)})`}
          </span>
          <span className="explorer-pager">
            <IconButton
              icon={ChevronLeftIcon}
              size="sm"
              label="Page précédente"
              disabled={view.page <= 1}
              onClick={() => {
                onViewChange({ page: view.page - 1 })
              }}
            />
            <span className="explorer-pager__page">
              Page {view.page} / {pageCount}
            </span>
            <IconButton
              icon={ChevronRightIcon}
              size="sm"
              label="Page suivante"
              disabled={view.page >= pageCount}
              onClick={() => {
                onViewChange({ page: view.page + 1 })
              }}
            />
            <label className="explorer-pager__size">
              <span className="explorer-pager__size-label">Lignes par page</span>
              <select
                value={view.pageSize}
                onChange={(event) => {
                  onViewChange({ pageSize: Number(event.target.value), page: 1 })
                }}
              >
                {PAGE_SIZES.map((size) => (
                  <option key={size} value={size}>
                    {size}
                  </option>
                ))}
              </select>
            </label>
          </span>
        </div>
        <p className="explorer-status__message" role="status" aria-live="polite">
          {status ||
            (activeCell && activeRow
              ? `${activeNumber ? `Ligne ${COUNT.format(activeNumber)}` : 'Nouvelle ligne'} · ${meta.primary_key
                  .map((name) => `${name} ${clipboardValue(activeRow.values[name]) || '—'}`)
                  .join(' · ')} · colonne ${activeCell.column}`
              : '')}
        </p>
      </footer>

      {columnsAnchor && (
        <Popover
          anchor={columnsAnchor}
          label="Colonnes affichées"
          alignRight
          onClose={() => {
            setColumnsAnchor(null)
          }}
        >
          <ColumnsPanel columns={meta.columns} state={columnState} onAction={onColumnAction} />
        </Popover>
      )}
      {structureOpen && (
        <TableStructure
          meta={meta}
          onClose={() => {
            setStructureOpen(false)
          }}
        />
      )}
      {viewing && viewedColumn && viewedRow && (
        <ValueViewer
          table={meta.name}
          column={viewedColumn}
          row={viewedRow}
          rowNumber={viewedNumber ?? 0}
          primaryKey={meta.primary_key}
          onCopy={copy}
          onClose={() => {
            setViewing(null)
          }}
        />
      )}
      {deleting && (
        <DeleteRowsDialog
          meta={meta}
          rows={deleting}
          onClose={() => {
            setDeleting(null)
          }}
          onConfirm={() => {
            dispatchStaging({ type: 'delete', rows: deleting })
            setDeleting(null)
            setSelection({ page: pageKey, ids: NO_SELECTION })
            announce('Suppression en attente : elle sera appliquée à l’enregistrement.')
          }}
        />
      )}
      {reviewing && (
        <PendingChangesDrawer
          meta={meta}
          staging={staging}
          onRevert={(id) => {
            dispatchStaging({ type: 'revert', id })
          }}
          onRevertCell={(id, column) => {
            dispatchStaging({ type: 'revertCell', id, column })
          }}
          onClose={() => {
            setReviewing(false)
          }}
        />
      )}
      <UnsavedChangesGuard dirty={dirty} table={meta.name} summary={summaryTitle(summary)} />
    </section>
  )
}
