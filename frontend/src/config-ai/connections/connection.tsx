import { type ComponentType, createContext, type ReactNode, useContext } from 'react'
import { createPortal } from 'react-dom'

import type { StatusTone } from '../../ui/Badge'
import type { LogoProps } from '../logos'

// Config AI › Connexions: one DESCRIPTOR per connection (id, title, logo, summary, badge, quick test, sub-tabs, body),
// rendered by the same grid of identical tiles and the same edit dialog. A new connection is a new descriptor in
// `registry`, never a new page: everything a service needs (key, options, lists, diagnostic…) lives in its sub-tabs.

// The address parameter that opens a connection's dialog (`?open=calendly`): deep links and the Toolbox OAuth return.
export const OPEN_PARAM = 'open'

export interface ConnectionBadge {
  tone: StatusTone
  label: string
}

// What a quick test (the icon button on the tile) answers: it replaces the badge until the connection changes.
export interface TestOutcome extends ConnectionBadge {
  // The full sentence, shown on hover of the badge and announced to assistive technology.
  detail?: string
}

export interface QuickTest {
  label: string
  run: () => Promise<TestOutcome | undefined>
  pending: boolean
  disabled?: boolean
  // Why the test cannot run now (tooltip of the disabled button).
  disabledReason?: string
}

export interface ConnectionTab {
  id: string
  label: string
}

export interface Connection {
  id: string
  title: string
  Logo: ComponentType<LogoProps>
  // WHICH account / model / mailbox this connection uses: one short line.
  summary: string
  // What the connection is for (hover help of the dialog).
  about: string
  badge: ConnectionBadge
  quickTest?: QuickTest
  tabs: readonly ConnectionTab[]
  // The tab the dialog opens on (the one that fixes what is missing); the first by default.
  initialTab?: string
  // The dialog's content: its `<Pane id>` blocks follow the selected tab (all stay mounted, so edits survive a tab change).
  body: ReactNode
}

// --- Inside the dialog -------------------------------------------------------------------------------------------

const TabContext = createContext<string | null>(null)
const ActiveContext = createContext(false)
// The footer element of the open dialog: every pane's actions are drawn there, so the buttons sit in ONE place.
const FooterContext = createContext<HTMLElement | null>(null)
const NavContext = createContext<(tab: string) => void>(() => undefined)

export const ConnectionTabProvider = TabContext.Provider
export const ConnectionFooterProvider = FooterContext.Provider
export const ConnectionNavProvider = NavContext.Provider

// True inside the selected tab's pane (a pane that loads something only loads it when it is shown).
export function usePaneActive() {
  return useContext(ActiveContext)
}

// Asks the dialog to show another tab (the Toolbox test's « fix » buttons).
export function useConnectionNav() {
  return useContext(NavContext)
}

export function Pane({ id, children }: { id: string; children: ReactNode }) {
  const active = useContext(TabContext) === id
  return (
    <div hidden={!active} className="conn-pane">
      <ActiveContext.Provider value={active}>{children}</ActiveContext.Provider>
    </div>
  )
}

interface PaneActionsProps {
  // Secondary actions: icon buttons with a tooltip, grouped on the left of the footer.
  secondary?: ReactNode
  // The primary action (Enregistrer…), alone on the right.
  children?: ReactNode
}

// The footer of the dialog for the selected tab. Same placement for every connection: secondary icons left, the
// primary button right.
export function PaneActions({ secondary, children }: PaneActionsProps) {
  const footer = useContext(FooterContext)
  const active = useContext(ActiveContext)
  if (!footer || !active) return null
  return createPortal(
    <div className="conn-actions">
      <div className="conn-actions__secondary">{secondary}</div>
      <div className="conn-actions__primary">{children}</div>
    </div>,
    footer,
  )
}
