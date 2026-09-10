import { useQueryClient } from '@tanstack/react-query'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link, useNavigate } from 'react-router'

import { ApiError } from '../api/client'
import {
  type ExplorerColumn,
  type ExplorerTable,
  explorerKeys,
  exportUrl,
  useExplorerRows,
  useExplorerTable,
} from '../api/explorer'
import { Badge } from '../ui/Badge'
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
  RefreshIcon,
  SearchIcon,
  TableIcon,
} from '../ui/icons'
import { Popover } from '../ui/Popover'
import { ColumnsPanel } from './ColumnsPanel'
import {
  type ColumnAction,
  type ColumnState,
  columnStateReducer,
  loadColumnState,
  saveColumnState,
} from './columnState'
import { ExplorerGrid, type CellPosition } from './ExplorerGrid'
import { type ColumnFilter, type ExplorerView, PAGE_SIZES, type SortKey, toRowsQuery } from './explorerView'
import { describeFilter } from './filters'
import type { NavigationOrigin } from './navigation'
import { tableLabel } from './tableCatalog'
import { TableStructure } from './TableStructure'
import { ValueViewer } from './ValueViewer'

const COUNT = new Intl.NumberFormat('fr-FR')
const SEARCH_DELAY_MS = 300
const STATUS_DURATION_MS = 3000

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

function Workspace({ meta, view, onViewChange, origin, rows, columnState, onColumnAction, onRefresh, onNavigate }: WorkspaceProps) {
  const navigate = useNavigate()
  const [searchText, setSearchText] = useState(view.search)
  const [status, setStatus] = useState('')
  const [activeCell, setActiveCell] = useState<CellPosition | null>(null)
  const [viewing, setViewing] = useState<CellPosition | null>(null)
  const [structureOpen, setStructureOpen] = useState(false)
  const [columnsAnchor, setColumnsAnchor] = useState<HTMLElement | null>(null)
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
  const viewedColumn = viewing ? byName.get(viewing.column) : undefined
  const viewedRow = viewing ? pageRows[viewing.row] : undefined
  const activeRow = activeCell ? pageRows[activeCell.row] : undefined

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
      <header className="explorer-toolbar">
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

      <ExplorerGrid
        meta={meta}
        rows={pageRows}
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
        onActiveCellChange={setActiveCell}
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
              ? `Ligne ${COUNT.format(firstRowNumber + activeCell.row)} · ${meta.primary_key
                  .map((name) => `${name} ${String(activeRow.values[name])}`)
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
          rowNumber={firstRowNumber + viewing.row}
          primaryKey={meta.primary_key}
          onCopy={copy}
          onClose={() => {
            setViewing(null)
          }}
        />
      )}
    </section>
  )
}
