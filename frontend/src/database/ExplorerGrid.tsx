import {
  type ColumnDef,
  type ColumnSizingState,
  getCoreRowModel,
  type Updater,
  useReactTable,
} from '@tanstack/react-table'
import { useVirtualizer } from '@tanstack/react-virtual'
import { type CSSProperties, type KeyboardEvent, type ReactNode, useEffect, useMemo, useRef, useState } from 'react'

import type { ExplorerColumn, ExplorerRow, ExplorerTable } from '../api/explorer'
import { Menu, type MenuItem, type MenuSection } from '../ui/Menu'
import { Popover } from '../ui/Popover'
import {
  ArrowDownIcon,
  ArrowUpIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  ExpandIcon,
  FilterIcon,
  LinkIcon,
  MinusCircleIcon,
  PinIcon,
} from '../ui/icons'
import type { Point } from '../ui/floating'
import { compactUuid, displayValue, isNumericKind } from './cells'
import { buildCellMenu } from './cellMenu'
import { ColumnFilterEditor } from './ColumnFilterEditor'
import { type ColumnAction, type ColumnState, defaultWidth, displayOrder, MAX_WIDTH, MIN_WIDTH } from './columnState'
import { type ColumnFilter, nextSort, type SortKey } from './explorerView'
import { GridHeader } from './GridHeader'
import { referencedRowHref } from './navigation'

const ROW_HEIGHT = 36
const ROW_NUMBER_ID = '__row'
const ROW_NUMBER_WIDTH = 64
const PAGE_STEP = 10
// Below this width a UUID cell shows its compact form.
const UUID_FULL_WIDTH = 290

export interface CellPosition {
  row: number
  column: string
}

interface ExplorerGridProps {
  meta: ExplorerTable
  rows: ExplorerRow[]
  // 1-based number of rows[0] in the filtered result (page offset + 1).
  firstRowNumber: number
  total: number
  columnState: ColumnState
  onColumnAction: (action: ColumnAction) => void
  sort: SortKey[]
  onSortChange: (sort: SortKey[]) => void
  filters: ColumnFilter[]
  onAddFilter: (filter: ColumnFilter) => void
  onRemoveFilter: (index: number) => void
  onViewValue: (cell: CellPosition) => void
  onNavigate: (href: string) => void
  onCopy: (text: string, message: string) => void
  onActiveCellChange: (cell: CellPosition | null) => void
  busy: boolean
  empty: ReactNode
}

type Floating =
  | { kind: 'cell'; cell: CellPosition; point: Point }
  | { kind: 'column'; column: string; anchor: HTMLElement }
  | { kind: 'filter'; column: string; anchor: HTMLElement }

// Server-paged, row-virtualized data grid (headless TanStack Table + Virtual): sticky header, pinned left columns,
// resizable/reorderable columns, roving-focus keyboard navigation and an accessible context menu.
export function ExplorerGrid({
  meta,
  rows,
  firstRowNumber,
  total,
  columnState,
  onColumnAction,
  sort,
  onSortChange,
  filters,
  onAddFilter,
  onRemoveFilter,
  onViewValue,
  onNavigate,
  onCopy,
  onActiveCellChange,
  busy,
  empty,
}: ExplorerGridProps) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const [active, setActive] = useState<{ row: number; col: number }>({ row: 0, col: 0 })
  const [floating, setFloating] = useState<Floating | null>(null)
  const [dragging, setDragging] = useState<string | null>(null)
  const byName = useMemo(() => new Map(meta.columns.map((column) => [column.name, column])), [meta.columns])

  const columns = useMemo<ColumnDef<ExplorerRow>[]>(
    () => [
      { id: ROW_NUMBER_ID, size: ROW_NUMBER_WIDTH, enableResizing: false },
      ...meta.columns.map(
        (column): ColumnDef<ExplorerRow> => ({
          id: column.name,
          accessorFn: (row) => row.values[column.name],
          size: defaultWidth(column),
          minSize: MIN_WIDTH,
          maxSize: MAX_WIDTH,
        }),
      ),
    ],
    [meta.columns],
  )

  const order = displayOrder(columnState)
  const columnSizing: ColumnSizingState = columnState.widths
  // TanStack Table is stateful by design (React Compiler skips this component); state is fully controlled here.
  // eslint-disable-next-line react-hooks/incompatible-library
  const table = useReactTable({
    data: rows,
    columns,
    getCoreRowModel: getCoreRowModel(),
    columnResizeMode: 'onChange',
    state: {
      columnOrder: [ROW_NUMBER_ID, ...order],
      columnVisibility: Object.fromEntries(columnState.hidden.map((name) => [name, false])),
      columnPinning: { left: [ROW_NUMBER_ID, ...order.filter((name) => columnState.pinned.includes(name))] },
      columnSizing,
    },
    onColumnSizingChange: (updater: Updater<ColumnSizingState>) => {
      onColumnAction({ type: 'resize', widths: typeof updater === 'function' ? updater(columnSizing) : updater })
    },
  })

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 12,
    initialRect: { width: 1200, height: 720 },
  })

  // Keep the active cell inside the data when the page, filters or columns change.
  const activeRow = Math.min(active.row, Math.max(rows.length - 1, 0))
  const activeCol = Math.min(active.col, Math.max(order.length - 1, 0))
  const activeColumn = order[activeCol]

  useEffect(() => {
    onActiveCellChange(rows.length > 0 && activeColumn ? { row: activeRow, column: activeColumn } : null)
  }, [activeRow, activeColumn, rows.length, onActiveCellChange])

  function focusCell(row: number, col: number) {
    const nextRow = Math.max(0, Math.min(row, rows.length - 1))
    const nextCol = Math.max(0, Math.min(col, order.length - 1))
    setActive({ row: nextRow, col: nextCol })
    virtualizer.scrollToIndex(nextRow)
    requestAnimationFrame(() => {
      scrollRef.current?.querySelector<HTMLElement>(`[data-cell="${String(nextRow)}:${String(nextCol)}"]`)?.focus()
    })
  }

  function cellAt(row: number, col: number): CellPosition | null {
    const column = order[col]
    return rows[row] && column ? { row, column } : null
  }

  function openCellMenu(row: number, col: number, point: Point) {
    const cell = cellAt(row, col)
    if (cell) setFloating({ kind: 'cell', cell, point })
  }

  function handleGridKeyDown(event: KeyboardEvent<HTMLTableSectionElement>) {
    const target = event.target
    if (!(target instanceof HTMLElement) || !target.dataset.cell) return
    const [row = 0, col = 0] = target.dataset.cell.split(':').map(Number)
    const moves: Record<string, [number, number]> = {
      ArrowDown: [row + 1, col],
      ArrowUp: [row - 1, col],
      ArrowRight: [row, col + 1],
      ArrowLeft: [row, col - 1],
      PageDown: [row + PAGE_STEP, col],
      PageUp: [row - PAGE_STEP, col],
      Home: event.ctrlKey ? [0, 0] : [row, 0],
      End: event.ctrlKey ? [rows.length - 1, order.length - 1] : [row, order.length - 1],
    }
    const move = moves[event.key]
    if (move) {
      event.preventDefault()
      focusCell(...move)
      return
    }
    const cell = cellAt(row, col)
    if (!cell) return
    if (event.key === 'Enter') {
      event.preventDefault()
      onViewValue(cell)
    } else if ((event.key === 'F10' && event.shiftKey) || event.key === 'ContextMenu') {
      event.preventDefault()
      const rect = target.getBoundingClientRect()
      openCellMenu(row, col, { x: rect.left + 8, y: rect.bottom })
    } else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'c' && !window.getSelection()?.toString()) {
      event.preventDefault()
      const copy = cellMenu(cell)
        .flatMap((section) => section.items)
        .find((item) => item.id === 'copy-cell')
      if (copy && !copy.disabled) copy.onSelect()
    }
  }

  function cellMenu(cell: CellPosition): MenuSection[] {
    const column = byName.get(cell.column)
    const row = rows[cell.row]
    if (!column || !row) return []
    return buildCellMenu(
      { column, row, columns: order, referencedBy: meta.referenced_by },
      {
        copy: onCopy,
        addFilter: onAddFilter,
        navigate: onNavigate,
        viewValue: () => {
          onViewValue(cell)
        },
      },
    )
  }

  function columnMenu(name: string, anchor: HTMLElement): MenuSection[] {
    const column = byName.get(name)
    if (!column) return []
    const sorted = sort.find((key) => key.column === name)
    const pinned = columnState.pinned.includes(name)
    // A column already in the sort changes direction in place (multi-sort priority kept); otherwise it becomes the
    // only sort key, like a plain header click.
    const sortBy = (desc: boolean) => {
      onSortChange(sorted ? sort.map((key) => (key.column === name ? { column: name, desc } : key)) : [{ column: name, desc }])
    }
    const columnItems: MenuItem[] = [
      {
        id: 'pin',
        label: pinned ? 'Désépingler' : 'Épingler à gauche',
        icon: PinIcon,
        onSelect: () => {
          onColumnAction({ type: 'pin', column: name, pinned: !pinned })
        },
      },
      {
        id: 'move-left',
        label: 'Déplacer à gauche',
        icon: ChevronLeftIcon,
        onSelect: () => {
          onColumnAction({ type: 'move', column: name, offset: -1 })
        },
      },
      {
        id: 'move-right',
        label: 'Déplacer à droite',
        icon: ChevronRightIcon,
        onSelect: () => {
          onColumnAction({ type: 'move', column: name, offset: 1 })
        },
      },
      {
        id: 'reset-width',
        label: 'Largeur par défaut',
        icon: ExpandIcon,
        onSelect: () => {
          onColumnAction({ type: 'resetWidth', column: name })
        },
      },
      {
        id: 'hide',
        label: 'Masquer la colonne',
        icon: MinusCircleIcon,
        disabled: order.length <= 1,
        onSelect: () => {
          onColumnAction({ type: 'toggle', column: name })
        },
      },
    ]
    if (column.filter_operators.length > 0) {
      columnItems.unshift({
        id: 'filter',
        label: 'Filtrer…',
        icon: FilterIcon,
        onSelect: () => {
          setFloating({ kind: 'filter', column: name, anchor })
        },
      })
    }
    const sortItems: MenuItem[] = [
      {
        id: 'sort-asc',
        label: 'Trier par ordre croissant',
        icon: ArrowUpIcon,
        disabled: !column.sortable || sorted?.desc === false,
        onSelect: () => {
          sortBy(false)
        },
      },
      {
        id: 'sort-desc',
        label: 'Trier par ordre décroissant',
        icon: ArrowDownIcon,
        disabled: !column.sortable || sorted?.desc === true,
        onSelect: () => {
          sortBy(true)
        },
      },
    ]
    if (sorted) {
      sortItems.push({
        id: 'sort-clear',
        label: 'Retirer du tri',
        icon: MinusCircleIcon,
        onSelect: () => {
          onSortChange(sort.filter((key) => key.column !== name))
        },
      })
    }
    return [
      { label: 'Tri', items: sortItems },
      { label: 'Colonne', items: columnItems },
    ]
  }

  function pinnedStyle(column: { getIsPinned: () => false | 'left' | 'right'; getStart: (position: 'left') => number }) {
    return column.getIsPinned() ? ({ position: 'sticky', left: column.getStart('left') } satisfies CSSProperties) : {}
  }

  const headerGroup = table.getHeaderGroups()[0]
  const totalWidth = table.getTotalSize()
  const tableRows = table.getRowModel().rows

  return (
    <div className="explorer-grid" ref={scrollRef} data-busy={busy ? '' : undefined}>
      {busy && <div className="explorer-grid__progress" role="progressbar" aria-label="Chargement des lignes" />}
      <table
        role="grid"
        aria-label={`Lignes de ${meta.name}`}
        aria-rowcount={total + 1}
        aria-colcount={order.length + 1}
        aria-busy={busy}
        className="grid"
        style={{ width: totalWidth }}
      >
        <thead className="grid__head">
          <tr className="grid__row" aria-rowindex={1}>
            {headerGroup?.headers.map((header) => {
              const style: CSSProperties = { width: header.getSize(), ...pinnedStyle(header.column) }
              if (header.column.id === ROW_NUMBER_ID) {
                return (
                  <th key={header.id} role="columnheader" className="grid__header grid__header--number" style={style} data-pinned="">
                    <span className="visually-hidden">Numéro de ligne</span>#
                  </th>
                )
              }
              const column = byName.get(header.column.id)
              if (!column) return null
              const columnFilters = filters.flatMap((filter, index) => (filter.column === column.name ? [{ filter, index }] : []))
              return (
                <GridHeader
                  key={header.id}
                  header={header}
                  column={column}
                  style={style}
                  sort={sort}
                  filterCount={columnFilters.length}
                  dragging={dragging}
                  onSort={(additive) => {
                    if (column.sortable) onSortChange(nextSort(sort, column.name, additive))
                  }}
                  onOpenFilter={(anchor) => {
                    setFloating({ kind: 'filter', column: column.name, anchor })
                  }}
                  onOpenMenu={(anchor) => {
                    setFloating({ kind: 'column', column: column.name, anchor })
                  }}
                  onResize={(width) => {
                    onColumnAction({ type: 'resize', widths: { [column.name]: width } })
                  }}
                  onResetWidth={() => {
                    onColumnAction({ type: 'resetWidth', column: column.name })
                  }}
                  onDragStart={() => {
                    setDragging(column.name)
                  }}
                  onDragEnd={() => {
                    setDragging(null)
                  }}
                  onDrop={(after) => {
                    if (!dragging) return
                    const before = after ? (order[order.indexOf(column.name) + 1] ?? null) : column.name
                    onColumnAction({ type: 'reorder', column: dragging, before })
                    setDragging(null)
                  }}
                />
              )
            })}
          </tr>
        </thead>
        <tbody className="grid__body" style={{ height: virtualizer.getTotalSize() }} onKeyDown={handleGridKeyDown}>
          {virtualizer.getVirtualItems().map((item) => {
            const row = tableRows[item.index]
            if (!row) return null
            return (
              <tr
                key={row.id}
                className="grid__row"
                aria-rowindex={firstRowNumber + item.index + 1}
                data-active={item.index === activeRow ? '' : undefined}
                data-even={item.index % 2 === 1 ? '' : undefined}
                style={{ transform: `translateY(${String(item.start)}px)`, height: ROW_HEIGHT }}
              >
                {row.getVisibleCells().map((cell) => {
                  const style: CSSProperties = { width: cell.column.getSize(), ...pinnedStyle(cell.column) }
                  if (cell.column.id === ROW_NUMBER_ID) {
                    return (
                      <th key={cell.id} scope="row" role="rowheader" className="grid__cell grid__cell--number" style={style} data-pinned="">
                        {firstRowNumber + item.index}
                      </th>
                    )
                  }
                  const column = byName.get(cell.column.id)
                  if (!column) return null
                  const col = order.indexOf(column.name)
                  const isActive = item.index === activeRow && col === activeCol
                  return (
                    <td
                      key={cell.id}
                      role="gridcell"
                      className="grid__cell"
                      style={style}
                      tabIndex={isActive ? 0 : -1}
                      data-cell={`${String(item.index)}:${String(col)}`}
                      data-kind={column.kind}
                      data-pinned={cell.column.getIsPinned() ? '' : undefined}
                      data-last-pinned={cell.column.getIsLastColumn('left') ? '' : undefined}
                      data-active={isActive ? '' : undefined}
                      onFocus={() => {
                        setActive({ row: item.index, col })
                      }}
                      onClick={() => {
                        setActive({ row: item.index, col })
                      }}
                      onDoubleClick={() => {
                        onViewValue({ row: item.index, column: column.name })
                      }}
                      onContextMenu={(event) => {
                        event.preventDefault()
                        setActive({ row: item.index, col })
                        openCellMenu(item.index, col, { x: event.clientX, y: event.clientY })
                      }}
                    >
                      <CellContent
                        column={column}
                        value={row.original.values[column.name]}
                        truncated={row.original.truncated.includes(column.name)}
                        width={cell.column.getSize()}
                        onNavigate={onNavigate}
                        onExpand={() => {
                          onViewValue({ row: item.index, column: column.name })
                        }}
                      />
                    </td>
                  )
                })}
              </tr>
            )
          })}
        </tbody>
      </table>
      {rows.length === 0 && <div className="explorer-grid__empty">{empty}</div>}

      {floating?.kind === 'cell' && (
        <Menu
          label={`Actions sur ${floating.cell.column}`}
          position={floating.point}
          sections={cellMenu(floating.cell)}
          onClose={() => {
            setFloating(null)
          }}
        />
      )}
      {floating?.kind === 'column' && (
        <Menu
          label={`Options de la colonne ${floating.column}`}
          position={{ x: floating.anchor.getBoundingClientRect().right, y: floating.anchor.getBoundingClientRect().bottom + 4 }}
          alignRight
          sections={columnMenu(floating.column, floating.anchor)}
          onClose={() => {
            setFloating(null)
          }}
        />
      )}
      {floating?.kind === 'filter' && byName.get(floating.column) && (
        <Popover
          anchor={floating.anchor}
          label={`Filtrer ${floating.column}`}
          onClose={() => {
            setFloating(null)
          }}
        >
          <ColumnFilterEditor
            column={byName.get(floating.column) as ExplorerColumn}
            active={filters.flatMap((filter, index) => (filter.column === floating.column ? [{ filter, index }] : []))}
            onApply={(filter) => {
              onAddFilter(filter)
              setFloating(null)
            }}
            onRemove={onRemoveFilter}
            onCancel={() => {
              setFloating(null)
            }}
          />
        </Popover>
      )}
    </div>
  )
}

interface CellContentProps {
  column: ExplorerColumn
  value: unknown
  truncated: boolean
  width: number
  onNavigate: (href: string) => void
  onExpand: () => void
}

function CellContent({ column, value, truncated, width, onNavigate, onExpand }: CellContentProps) {
  if (column.masked) return <span className="cell__masked">masqué</span>
  if (value === null || value === undefined) return <span className="cell__null">NULL</span>
  const full = displayValue(value, column.kind)
  const text = column.kind === 'uuid' && width < UUID_FULL_WIDTH ? compactUuid(full) : full
  const target = referencedRowHref(column, value)
  const className = [
    'cell__text',
    isNumericKind(column.kind) && 'cell__text--numeric',
    (column.kind === 'uuid' || column.kind === 'json' || column.kind === 'array') && 'cell__text--mono',
    column.kind === 'boolean' && (value === true ? 'cell__text--true' : 'cell__text--false'),
    target && 'cell__text--link',
  ]
    .filter(Boolean)
    .join(' ')
  return (
    <>
      <span className={className} title={full.length > 24 ? full : undefined}>
        {text}
        {truncated && '…'}
      </span>
      {target && column.foreign_key && (
        <button
          type="button"
          tabIndex={-1}
          className="cell__action"
          aria-label={`Ouvrir la ligne référencée dans ${column.foreign_key.table}`}
          title={`Ouvrir dans ${column.foreign_key.table}`}
          onClick={(event) => {
            event.stopPropagation()
            onNavigate(target)
          }}
        >
          <LinkIcon size={14} />
        </button>
      )}
      {truncated && (
        <button
          type="button"
          tabIndex={-1}
          className="cell__action"
          aria-label="Voir la valeur complète"
          title="Voir la valeur complète"
          onClick={(event) => {
            event.stopPropagation()
            onExpand()
          }}
        >
          <ExpandIcon size={14} />
        </button>
      )}
    </>
  )
}
