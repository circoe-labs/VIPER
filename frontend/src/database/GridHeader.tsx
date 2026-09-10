import type { Header } from '@tanstack/react-table'
import { type CSSProperties, type DragEvent, type KeyboardEvent, useState } from 'react'

import type { ExplorerColumn, ExplorerRow } from '../api/explorer'
import { IconButton } from '../ui/Button'
import { ArrowDownIcon, ArrowUpIcon, FilterIcon, KeyIcon, LinkIcon, MoreIcon } from '../ui/icons'
import { MAX_WIDTH, MIN_WIDTH } from './columnState'
import type { SortKey } from './explorerView'

const RESIZE_STEP = 16

interface GridHeaderProps {
  header: Header<ExplorerRow, unknown>
  column: ExplorerColumn
  style: CSSProperties
  sort: SortKey[]
  filterCount: number
  dragging: string | null
  onSort: (additive: boolean) => void
  onOpenFilter: (anchor: HTMLElement) => void
  onOpenMenu: (anchor: HTMLElement) => void
  onResize: (width: number) => void
  onResetWidth: () => void
  onDragStart: () => void
  onDragEnd: () => void
  // `after`: dropped on the right half of this header.
  onDrop: (after: boolean) => void
}

const SORT_LABELS = { asc: 'tri croissant', desc: 'tri décroissant' }

// Column header: sort (click, Shift+click to add), drag to reorder, filter popover, options menu, and a resize
// handle that also works with the keyboard (focus it, then ← / →).
export function GridHeader({
  header,
  column,
  style,
  sort,
  filterCount,
  dragging,
  onSort,
  onOpenFilter,
  onOpenMenu,
  onResize,
  onResetWidth,
  onDragStart,
  onDragEnd,
  onDrop,
}: GridHeaderProps) {
  const [dropSide, setDropSide] = useState<'before' | 'after' | null>(null)
  const sortIndex = sort.findIndex((key) => key.column === column.name)
  const sortKey = sort[sortIndex]
  const direction = sortKey ? (sortKey.desc ? 'desc' : 'asc') : null
  const width = header.getSize()
  const SortIcon = direction === 'desc' ? ArrowDownIcon : ArrowUpIcon

  function dragOver(event: DragEvent<HTMLTableCellElement>) {
    if (!dragging || dragging === column.name) return
    event.preventDefault()
    const { left, width: cellWidth } = event.currentTarget.getBoundingClientRect()
    setDropSide(event.clientX > left + cellWidth / 2 ? 'after' : 'before')
  }

  function resizeWithKeyboard(event: KeyboardEvent<HTMLDivElement>) {
    const delta = event.key === 'ArrowLeft' ? -RESIZE_STEP : event.key === 'ArrowRight' ? RESIZE_STEP : 0
    if (!delta) return
    event.preventDefault()
    onResize(width + delta)
  }

  const stateLabel = direction
    ? `${SORT_LABELS[direction]}${sort.length > 1 ? ` (priorité ${String(sortIndex + 1)})` : ''}`
    : 'non trié'

  return (
    <th
      role="columnheader"
      className="grid__header"
      style={style}
      aria-sort={direction === 'asc' ? 'ascending' : direction === 'desc' ? 'descending' : undefined}
      data-pinned={header.column.getIsPinned() ? '' : undefined}
      data-last-pinned={header.column.getIsLastColumn('left') ? '' : undefined}
      data-drop={dropSide ?? undefined}
      onDragOver={dragOver}
      onDragLeave={() => {
        setDropSide(null)
      }}
      onDrop={(event) => {
        event.preventDefault()
        setDropSide(null)
        onDrop(dropSide === 'after')
      }}
      onContextMenu={(event) => {
        event.preventDefault()
        const menuButton = event.currentTarget.querySelector<HTMLElement>('.grid__header-menu')
        if (menuButton) onOpenMenu(menuButton)
      }}
    >
      <button
        type="button"
        className="grid__header-sort"
        draggable
        aria-label={`${column.name}, ${stateLabel}`}
        title="Cliquer pour trier · Maj+clic pour ajouter au tri · glisser pour déplacer"
        onClick={(event) => {
          onSort(event.shiftKey)
        }}
        onDragStart={(event) => {
          event.dataTransfer.effectAllowed = 'move'
          event.dataTransfer.setData('text/plain', column.name)
          onDragStart()
        }}
        onDragEnd={onDragEnd}
      >
        <span className="grid__header-name">
          {column.primary_key && <KeyIcon size={14} className="grid__header-key" aria-hidden="true" />}
          {column.foreign_key && <LinkIcon size={14} className="grid__header-fk" aria-hidden="true" />}
          <span className="grid__header-text">{column.name}</span>
          {direction && (
            <span className="grid__header-sorted" aria-hidden="true">
              <SortIcon size={14} />
              {sort.length > 1 && <span>{sortIndex + 1}</span>}
            </span>
          )}
        </span>
        <span className="grid__header-type">
          {column.sql_type.replace('timestamp with time zone', 'timestamptz')}
          {column.nullable ? '' : ' · requis'}
        </span>
      </button>
      <span className="grid__header-tools">
        {column.filter_operators.length > 0 && (
          <IconButton
            icon={FilterIcon}
            size="sm"
            className="grid__header-filter"
            data-active={filterCount > 0 ? '' : undefined}
            label={filterCount > 0 ? `Filtres sur ${column.name} (${String(filterCount)})` : `Filtrer ${column.name}`}
            onClick={(event) => {
              onOpenFilter(event.currentTarget)
            }}
          />
        )}
        <IconButton
          icon={MoreIcon}
          size="sm"
          className="grid__header-menu"
          label={`Options de la colonne ${column.name}`}
          aria-haspopup="menu"
          onClick={(event) => {
            onOpenMenu(event.currentTarget)
          }}
        />
      </span>
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label={`Largeur de ${column.name}`}
        aria-valuenow={width}
        aria-valuemin={MIN_WIDTH}
        aria-valuemax={MAX_WIDTH}
        tabIndex={0}
        className="grid__resizer"
        data-resizing={header.column.getIsResizing() ? '' : undefined}
        onMouseDown={header.getResizeHandler()}
        onTouchStart={header.getResizeHandler()}
        onDoubleClick={onResetWidth}
        onKeyDown={resizeWithKeyboard}
      />
    </th>
  )
}
