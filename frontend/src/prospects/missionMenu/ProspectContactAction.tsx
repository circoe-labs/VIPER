import { type KeyboardEvent, type MouseEvent, type ReactNode, useRef, useState } from 'react'
import { useNavigate } from 'react-router'

import { Button } from '../../ui/Button'
import type { Point } from '../../ui/floating'
import { BuildingIcon, CompassIcon, LinkIcon, MailIcon, TargetIcon, UsersIcon } from '../../ui/icons'
import { Menu, type MenuItem } from '../../ui/Menu'

// « Contacter » reuses the Contact workbench deep link (`/contact?prospect=<id>`, contact/criteria.ts): no second flow.
export function contactHref(prospectId: string): string {
  return `/contact?prospect=${encodeURIComponent(prospectId)}`
}

interface ActionProps {
  prospectId: string
  // Not contactable (« Ne pas contacter »): the action stays visible, disabled, with the reason as tooltip.
  disabledReason?: string | null
  className?: string
}

export function useContactAction(prospectId: string) {
  const navigate = useNavigate()
  return () => {
    void navigate(contactHref(prospectId))
  }
}

// Explicit, keyboard-accessible equivalent of the context menu entry (the right click is never the only way).
export function ProspectContactButton({ prospectId, disabledReason, className }: ActionProps) {
  const contact = useContactAction(prospectId)
  return (
    <Button
      variant="secondary"
      icon={MailIcon}
      className={className}
      disabled={Boolean(disabledReason)}
      title={disabledReason ?? undefined}
      onClick={contact}
    >
      Contacter
    </Button>
  )
}

// What the sheet can do besides « Contacter » (which the surface owns). Each entry is optional: an absent one is not
// offered; `disabledReason` keeps it visible but off, with the reason as tooltip. Every entry has a visible button
// elsewhere on the sheet (header, Relations card, Score card, Entreprise card).
export interface SheetMenuActions {
  link?: () => void
  mission?: () => void
  reassess?: { run: () => void; busy?: boolean; disabledReason?: string | null }
  graph?: () => void
  company?: { open: () => void; disabledReason?: string | null }
}

interface SurfaceProps extends ActionProps {
  actions?: SheetMenuActions
  children: ReactNode
}

const NATIVE_TARGETS = 'a, button, input, select, textarea, [contenteditable="true"]'
// The context-menu key / Shift+F10 fire `contextmenu` right after their `keydown`.
const KEYBOARD_WINDOW_MS = 400

export function menuItems(contact: () => void, disabledReason: string | null | undefined, actions: SheetMenuActions = {}): MenuItem[][] {
  const first: MenuItem[] = []
  if (actions.link) first.push({ id: 'link', label: 'Lier à…', icon: LinkIcon, onSelect: actions.link })
  if (actions.mission) first.push({ id: 'mission', label: 'Mission', icon: TargetIcon, onSelect: actions.mission })
  first.push({
    id: 'contact',
    label: 'Contacter',
    icon: MailIcon,
    disabled: Boolean(disabledReason),
    title: disabledReason ?? undefined,
    onSelect: contact,
  })
  const second: MenuItem[] = []
  const { reassess, graph, company } = actions
  if (reassess) {
    second.push({
      id: 'reassess',
      label: 'Réévaluer le score',
      icon: CompassIcon,
      disabled: Boolean(reassess.busy) || Boolean(reassess.disabledReason),
      title: reassess.disabledReason ?? (reassess.busy ? 'Une réévaluation est déjà en cours.' : undefined),
      onSelect: reassess.run,
    })
  }
  if (graph) second.push({ id: 'graph', label: 'Graph', icon: UsersIcon, onSelect: graph })
  if (company) {
    second.push({
      id: 'company',
      label: 'Société',
      icon: BuildingIcon,
      disabled: Boolean(company.disabledReason),
      title: company.disabledReason ?? undefined,
      onSelect: company.open,
    })
  }
  return [first, second].filter((items) => items.length > 0)
}

// Wrap the prospect sheet: right click, the context-menu key or Shift+F10 on its surface offers the sheet's actions
// (« Lier à… », « Mission », « Contacter », « Réévaluer le score », « Graph », « Société »). Links, buttons and fields
// keep the browser's own menu for the mouse; the keyboard shortcut always opens ours, at the focused element.
// (The browser's menu of a focused field stays reachable by right click.)
// Pair it with the visible buttons (header, cards): the menu is a shortcut, never the only way.
export function ProspectContextMenuSurface({ prospectId, disabledReason, className, actions, children }: SurfaceProps) {
  const [position, setPosition] = useState<Point | null>(null)
  const contact = useContactAction(prospectId)
  const keyboardAt = useRef(0)

  // The keyboard path opens the menu itself (below the focused element) and swallows the browser's own menu.
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key !== 'ContextMenu' && !(event.key === 'F10' && event.shiftKey)) return
    event.preventDefault()
    keyboardAt.current = Date.now()
    const box = (document.activeElement ?? (event.target as HTMLElement)).getBoundingClientRect()
    setPosition({ x: box.left + 16, y: box.bottom })
  }
  const onContextMenu = (event: MouseEvent) => {
    // The `contextmenu` event that follows a handled key press: already opened.
    if (Date.now() - keyboardAt.current < KEYBOARD_WINDOW_MS) {
      keyboardAt.current = 0
      event.preventDefault()
      return
    }
    if ((event.target as HTMLElement).closest(NATIVE_TARGETS)) return
    event.preventDefault()
    setPosition({ x: event.clientX, y: event.clientY })
  }
  return (
    <div
      className={className}
      onContextMenu={onContextMenu}
      onKeyDown={onKeyDown}
      onMouseDown={() => {
        keyboardAt.current = 0
      }}
    >
      {children}
      {position && (
        <Menu
          label="Actions du prospect"
          position={position}
          sections={menuItems(contact, disabledReason, actions).map((items) => ({ items }))}
          onClose={() => {
            setPosition(null)
          }}
        />
      )}
    </div>
  )
}
