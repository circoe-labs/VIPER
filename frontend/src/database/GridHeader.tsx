import type { Header } from '@tanstack/react-table'
import { type CSSProperties, type DragEvent, type KeyboardEvent, useState } from 'react'

import type { ExplorerColumn, ExplorerRow } from '../api/explorer'
import { IconButton } from '../ui/Button'
import { ArrowDownIcon, ArrowUpIcon, FilterIcon, KeyIcon, LinkIcon, LockIcon, MoreIcon } from '../ui/icons'
import { MAX_WIDTH, MIN_WIDTH } from './columnState'
import type { SortKey } from './explorerView'

const RESIZE_STEP = 16

interface GridHeaderProps {
  header: Header<ExplorerRow, unknown>
  column: ExplorerColumn
  // Position among the displayed columns (`data-header`, for the header row's arrow-key navigation).
  index: number
  // The header row is one tab stop: only the active column's header is in the tab order.
  tabbable: boolean
  // Id of the element describing the header's keyboard shortcuts.
  hintId: string
  // Why the column cannot be edited, in a table that can be (null: editable, or nothing is editable here).
  lockReason: string | null
  style: CSSProperties
  sort: SortKey[]
  filterCount: number
  dragging: string | null
  onFocus: () => void
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

// Column header: sort (click, Shift+click to add), drag to reorder, filter popover, options menu and a resize handle
// for the mouse. From the keyboard the header is one focus stop (the grid moves between headers with ← / →) whose
// actions are keys: Enter sorts, Shift+Enter adds to the sort, Alt+↓ (or Shift+F10) opens the options menu — filter
// included —, Shift+← / Shift+→ resize.
export function GridHeader({
  header,
  column,
  index,
  tabbable,
  hintId,
  lockReason,
  style,
  sort,
  filterCount,
  dragging,
  onFocus,
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

  // The header's own keys; the grid handles the others (moving between headers, down into the rows).
  function headerKeys(event: KeyboardEvent<HTMLButtonElement>) {
    const resize = event.shiftKey && !event.altKey && (event.key === 'ArrowLeft' || event.key === 'ArrowRight')
    if (resize) {
      const delta = event.key === 'ArrowLeft' ? -RESIZE_STEP : RESIZE_STEP
      onResize(Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, width + delta)))
    } else if ((event.altKey && event.key === 'ArrowDown') || (event.shiftKey && event.key === 'F10') || event.key === 'ContextMenu') {
      onOpenMenu(event.currentTarget)
    } else if (event.key === 'Enter' && event.shiftKey) {
      onSort(true)
    } else {
      return
    }
    event.preventDefault()
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
        tabIndex={tabbable ? 0 : -1}
        data-header={index}
        aria-label={`${column.name}, ${stateLabel}`}
        aria-describedby={hintId}
        title="Cliquer pour trier · Maj+clic pour ajouter au tri · glisser pour déplacer"
        onFocus={onFocus}
        onKeyDown={headerKeys}
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
          {lockReason && (
            <span className="grid__header-lock" title={`Lecture seule : ${lockReason}`}>
              <LockIcon size={12} />
              <span className="visually-hidden">(lecture seule)</span>
            </span>
          )}
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
            tabIndex={-1}
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
          tabIndex={-1}
          label={`Options de la colonne ${column.name}`}
          aria-haspopup="menu"
          onClick={(event) => {
            onOpenMenu(event.currentTarget)
          }}
        />
      </span>
      {/* Mouse handle; the keyboard resizes from the header (Shift+← / Shift+→). */}
      <div
        aria-hidden="true"
        className="grid__resizer"
        data-resizing={header.column.getIsResizing() ? '' : undefined}
        onMouseDown={header.getResizeHandler()}
        onTouchStart={header.getResizeHandler()}
        onDoubleClick={onResetWidth}
      />
    </th>
  )
}
