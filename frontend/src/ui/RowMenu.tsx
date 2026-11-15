import { type MouseEvent, type ReactNode, useState } from 'react'

import { IconButton } from './Button'
import type { Point } from './floating'
import { MoreIcon } from './icons'
import { Menu, type MenuItem } from './Menu'

interface OpenMenu<T> {
  row: T
  position: Point
  // Opened from the « … » button (right edge) rather than at the pointer.
  alignRight: boolean
}

// Row actions of a table or a list: a « … » button at the end of the row and the same actions on right click.
// `actions(row)` lists them once; `name(row)` names the row for assistive tech (« Actions de LinkedIn »).
//
//   const rowMenu = useRowMenu(row => `Actions de ${row.name}`, row => [{ id: 'edit', label: 'Modifier', onSelect }])
//   <tr onContextMenu={rowMenu.onContextMenu(row)}> … <td>{rowMenu.button(row)}</td></tr>
//   {rowMenu.menu}
export function useRowMenu<T>(label: (row: T) => string, actions: (row: T) => MenuItem[]) {
  const [open, setOpen] = useState<OpenMenu<T> | null>(null)

  const onContextMenu = (row: T) => (event: MouseEvent) => {
    // A link or a control keeps the browser's own menu (copy the address…): only the row itself opens ours.
    if ((event.target as HTMLElement).closest('a, button, input, select, textarea')) return
    event.preventDefault()
    setOpen({ row, position: { x: event.clientX, y: event.clientY }, alignRight: false })
  }

  const button = (row: T): ReactNode => (
    <IconButton
      icon={MoreIcon}
      size="sm"
      label={label(row)}
      aria-haspopup="menu"
      onClick={(event) => {
        const box = event.currentTarget.getBoundingClientRect()
        setOpen({ row, position: { x: box.right, y: box.bottom }, alignRight: true })
      }}
    />
  )

  const menu = open ? (
    <Menu
      label={label(open.row)}
      position={open.position}
      alignRight={open.alignRight}
      sections={[{ items: actions(open.row) }]}
      onClose={() => {
        setOpen(null)
      }}
    />
  ) : null

  return { onContextMenu, button, menu }
}
