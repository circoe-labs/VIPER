import { type KeyboardEvent, useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'

import { type Point, useOutsidePress, useRestoreFocus, useViewportClamp } from './floating'
import type { IconComponent } from './icons'
import './menu.css'

export interface MenuItem {
  id: string
  label: string
  icon?: IconComponent
  // Secondary text on the right (keyboard shortcut, target table…).
  hint?: string
  disabled?: boolean
  onSelect: () => void
}

export interface MenuSection {
  label?: string
  items: MenuItem[]
}

interface MenuProps {
  // Accessible name of the menu.
  label: string
  // Viewport coordinates of the pointer (context menu) or of the trigger's corner.
  position: Point
  // Open leftwards from `position` (menus attached to a trigger's right edge).
  alignRight?: boolean
  sections: MenuSection[]
  // Esc, Tab, outside press, and after an item is chosen. Focus returns to what had it before.
  onClose: () => void
}

// Context / action menu (WAI-ARIA menu pattern): arrow keys, Home/End, Enter/Space, Esc; rendered in a portal.
export function Menu({ label, position, alignRight = false, sections, onClose }: MenuProps) {
  const ref = useRef<HTMLDivElement>(null)
  const { x, y } = useViewportClamp(ref, position, alignRight)
  useRestoreFocus()
  useOutsidePress(ref, onClose)

  useEffect(() => {
    ref.current?.querySelector<HTMLElement>('[role="menuitem"]:not(:disabled)')?.focus()
  }, [])

  function items() {
    return [...(ref.current?.querySelectorAll<HTMLElement>('[role="menuitem"]:not(:disabled)') ?? [])]
  }

  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const all = items()
    const current = all.indexOf(document.activeElement as HTMLElement)
    const move = (index: number) => {
      event.preventDefault()
      all[(index + all.length) % all.length]?.focus()
    }
    switch (event.key) {
      case 'ArrowDown':
        move(current + 1)
        break
      case 'ArrowUp':
        move(current - 1)
        break
      case 'Home':
        move(0)
        break
      case 'End':
        move(all.length - 1)
        break
      case 'Escape':
      case 'Tab':
        event.preventDefault()
        event.stopPropagation()
        onClose()
        break
    }
  }

  return createPortal(
    <div
      ref={ref}
      role="menu"
      aria-label={label}
      className="menu"
      style={{ left: x, top: y }}
      onKeyDown={handleKeyDown}
      onContextMenu={(event) => {
        event.preventDefault()
      }}
    >
      {sections.map((section, index) => (
        <div key={section.label ?? index} role="group" aria-label={section.label} className="menu__section">
          {section.label && (
            <p className="menu__label" aria-hidden="true">
              {section.label}
            </p>
          )}
          {section.items.map(({ id, label: itemLabel, icon: Icon, hint, disabled, onSelect }) => (
            <button
              key={id}
              type="button"
              role="menuitem"
              tabIndex={-1}
              className="menu__item"
              disabled={disabled}
              onClick={() => {
                onClose()
                onSelect()
              }}
            >
              <span className="menu__icon">{Icon && <Icon size={16} />}</span>
              <span className="menu__text">{itemLabel}</span>
              {hint && <span className="menu__hint">{hint}</span>}
            </button>
          ))}
        </div>
      ))}
    </div>,
    document.body,
  )
}
