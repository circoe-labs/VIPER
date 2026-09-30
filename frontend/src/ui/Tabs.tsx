import { type KeyboardEvent, type ReactNode, useId, useRef } from 'react'

import './tabs.css'

export interface TabItem<T extends string> {
  id: T
  // Visible name of the tab (its accessible name, with `extra`).
  label: ReactNode
  // Trailing content inside the tab: a count, a status badge, an « unsaved » mark.
  extra?: ReactNode
}

interface TabsProps<T extends string> {
  // Accessible name of the tab list.
  label: string
  tabs: readonly TabItem<T>[]
  selected: T
  onSelect: (id: T) => void
  // The selected tab's panel.
  children: ReactNode
  className?: string
}

// In-page tabs (WAI-ARIA tabs pattern, automatic activation): one tab stop — the selected tab — then ←/→ move and
// select, Home/End jump to the first/last tab; the panel below is labelled by its tab. For sections that must be
// deep-linkable, use links instead (Paramètres' tab bar).
export function Tabs<T extends string>({ label, tabs, selected, onSelect, children, className }: TabsProps<T>) {
  const prefix = useId()
  const listRef = useRef<HTMLDivElement>(null)
  const tabId = (id: T) => `${prefix}-tab-${id}`
  const panelId = `${prefix}-panel`

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const index = tabs.findIndex((tab) => tab.id === selected)
    const last = tabs.length - 1
    const target = {
      ArrowRight: index >= last ? 0 : index + 1,
      ArrowLeft: index <= 0 ? last : index - 1,
      Home: 0,
      End: last,
    }[event.key]
    const next = target === undefined ? undefined : tabs[target]
    if (!next) return
    event.preventDefault()
    onSelect(next.id)
    listRef.current?.querySelector<HTMLElement>(`#${CSS.escape(tabId(next.id))}`)?.focus()
  }

  return (
    <div className={['tabs', className].filter(Boolean).join(' ')}>
      <div ref={listRef} className="tabs__list" role="tablist" aria-label={label} onKeyDown={onKeyDown}>
        {tabs.map((tab) => {
          const current = tab.id === selected
          return (
            <button
              key={tab.id}
              type="button"
              role="tab"
              id={tabId(tab.id)}
              className="tabs__tab"
              aria-selected={current}
              aria-controls={current ? panelId : undefined}
              tabIndex={current ? 0 : -1}
              onClick={() => {
                if (!current) onSelect(tab.id)
              }}
            >
              <span className="tabs__label">{tab.label}</span>
              {tab.extra}
            </button>
          )
        })}
      </div>
      <div id={panelId} role="tabpanel" aria-labelledby={tabId(selected)} className="tabs__panel">
        {children}
      </div>
    </div>
  )
}
