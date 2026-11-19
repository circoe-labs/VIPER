import { type KeyboardEvent, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

import { type Point, useOutsidePress, useRestoreFocus, useViewportClamp } from './floating'
import { CheckIcon, ChevronRightIcon, type IconComponent } from './icons'
import './menu.css'

export interface SubmenuItem {
  id: string
  label: string
  // The current value: marked with a check (`menuitemradio`, `aria-checked`).
  checked?: boolean
  onSelect: () => void
}

export interface Submenu {
  // Accessible name of the nested menu.
  label: string
  items: SubmenuItem[]
}

export interface MenuItem {
  id: string
  label: string
  icon?: IconComponent
  // Secondary text on the right (keyboard shortcut, target table…).
  hint?: string
  // Tooltip, e.g. the full reason of a disabled action.
  title?: string
  disabled?: boolean
  danger?: boolean
  // Nested choice list, opened on hover, click, Enter or ArrowRight. The item then only opens it: `onSelect` is
  // not called for the item itself (each choice has its own).
  submenu?: Submenu
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
  // `position` is the menu's bottom edge: it opens upwards (triggers in a bar at the bottom of the screen).
  above?: boolean
  sections: MenuSection[]
  // Esc, Tab, outside press, and after an item is chosen. Focus returns to what had it before.
  onClose: () => void
}

// Pause before a hovered submenu opens or closes, so a diagonal move towards it does not flicker.
const HOVER_INTENT_MS = 150
const VIEWPORT_MARGIN = 8

interface OpenSubmenu {
  id: string
  // Took focus (keyboard / click) or only shown (hover, focus stays on the parent).
  focus: boolean
}

// Nested menu of a parent item: opens to the right, flips to the left / slides up when the viewport has no room.
function SubmenuList({
  submenu,
  focusOnOpen,
  onChoose,
  onLeave,
}: {
  submenu: Submenu
  focusOnOpen: boolean
  onChoose: (item: SubmenuItem) => void
  onLeave: () => void
}) {
  const ref = useRef<HTMLDivElement>(null)
  const [placement, setPlacement] = useState({ flip: false, shift: 0 })

  function radios() {
    return [...(ref.current?.querySelectorAll<HTMLElement>('[role="menuitemradio"]') ?? [])]
  }

  useLayoutEffect(() => {
    const element = ref.current
    const host = element?.parentElement?.getBoundingClientRect()
    if (!element || !host) return
    const { width, height } = element.getBoundingClientRect()
    const flip = host.right + width > window.innerWidth - VIEWPORT_MARGIN && host.left - width >= VIEWPORT_MARGIN
    const overflow = host.top + height - (window.innerHeight - VIEWPORT_MARGIN)
    setPlacement({ flip, shift: overflow > 0 ? Math.max(0, Math.min(overflow, host.top - VIEWPORT_MARGIN)) : 0 })
  }, [])

  useEffect(() => {
    if (!focusOnOpen) return
    const all = radios()
    const checked = all.find((element) => element.getAttribute('aria-checked') === 'true')
    ;(checked ?? all[0])?.focus()
  }, [focusOnOpen])

  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const all = radios()
    const current = all.indexOf(document.activeElement as HTMLElement)
    const move = (index: number) => {
      event.preventDefault()
      event.stopPropagation()
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
      case 'ArrowLeft':
      case 'Escape':
        // Closes only the submenu; the parent menu stays open.
        event.preventDefault()
        event.stopPropagation()
        onLeave()
        break
    }
  }

  return (
    <div
      ref={ref}
      role="menu"
      aria-label={submenu.label}
      className={placement.flip ? 'menu menu--sub menu--sub-left' : 'menu menu--sub'}
      style={placement.shift ? { marginTop: -placement.shift } : undefined}
      onKeyDown={handleKeyDown}
    >
      {submenu.items.map((item) => (
        <button
          key={item.id}
          type="button"
          role="menuitemradio"
          aria-checked={item.checked === true}
          tabIndex={-1}
          className="menu__item"
          onClick={() => {
            onChoose(item)
          }}
        >
          <span className="menu__icon">{item.checked && <CheckIcon size={16} />}</span>
          <span className="menu__text">{item.label}</span>
        </button>
      ))}
    </div>
  )
}

// Context / action menu (WAI-ARIA menu pattern): arrow keys, Home/End, Enter/Space, Esc; rendered in a portal.
// An item with a `submenu` follows the nested-menu pattern (aria-haspopup, aria-expanded, ArrowRight / ArrowLeft).
export function Menu({ label, position, alignRight = false, above = false, sections, onClose }: MenuProps) {
  const ref = useRef<HTMLDivElement>(null)
  const { x, y } = useViewportClamp(ref, position, alignRight, above)
  const [open, setOpen] = useState<OpenSubmenu | null>(null)
  const timer = useRef<number | undefined>(undefined)
  useRestoreFocus()
  useOutsidePress(ref, onClose)

  useEffect(() => {
    ref.current?.querySelector<HTMLElement>('[role="menuitem"]:not(:disabled)')?.focus()
    return () => {
      window.clearTimeout(timer.current)
    }
  }, [])

  function schedule(next: OpenSubmenu | null, delay = 0) {
    window.clearTimeout(timer.current)
    if (delay === 0) setOpen(next)
    else
      timer.current = window.setTimeout(() => {
        setOpen(next)
      }, delay)
  }

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
      case 'ArrowRight': {
        const focused = all[current]
        const id = focused?.dataset.itemId
        if (id && focused.getAttribute('aria-haspopup') === 'menu') {
          event.preventDefault()
          schedule({ id, focus: true })
        }
        break
      }
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
          {section.items.map(({ id, label: itemLabel, icon: Icon, hint, title, disabled, danger, submenu, onSelect }) => {
            const expanded = submenu !== undefined && open?.id === id
            const button = (
              <button
                type="button"
                role="menuitem"
                tabIndex={-1}
                data-item-id={id}
                className={danger ? 'menu__item menu__item--danger' : 'menu__item'}
                title={title}
                disabled={disabled}
                aria-haspopup={submenu ? 'menu' : undefined}
                aria-expanded={submenu ? expanded : undefined}
                onMouseEnter={
                  submenu
                    ? undefined
                    : () => {
                        schedule(null)
                      }
                }
                onFocus={() => {
                  if (open && open.id !== id) schedule(null)
                }}
                onClick={() => {
                  if (submenu) {
                    schedule({ id, focus: true })
                    return
                  }
                  onClose()
                  onSelect()
                }}
              >
                <span className="menu__icon">{Icon && <Icon size={16} />}</span>
                <span className="menu__text">{itemLabel}</span>
                {hint && <span className="menu__hint">{hint}</span>}
                {submenu && <ChevronRightIcon size={16} className="menu__chevron" />}
              </button>
            )
            if (!submenu) return <div key={id}>{button}</div>
            return (
              <div
                key={id}
                className="menu__host"
                onMouseEnter={() => {
                  if (expanded) schedule(open)
                  else schedule({ id, focus: false }, HOVER_INTENT_MS)
                }}
                onMouseLeave={() => {
                  schedule(null, HOVER_INTENT_MS)
                }}
              >
                {button}
                {expanded && (
                  <SubmenuList
                    submenu={submenu}
                    focusOnOpen={open.focus}
                    onChoose={(choice) => {
                      onClose()
                      choice.onSelect()
                    }}
                    onLeave={() => {
                      schedule(null)
                      ref.current?.querySelector<HTMLElement>(`[data-item-id="${id}"]`)?.focus()
                    }}
                  />
                )}
              </div>
            )
          })}
        </div>
      ))}
    </div>,
    document.body,
  )
}
