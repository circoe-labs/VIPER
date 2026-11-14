import type { ReactNode } from 'react'

import { SpinnerIcon } from '../ui/icons'
import './entities.css'

interface EntityToolbarProps {
  // « Tous les prospects »
  title: string
  // « 1 051 prospects »; undefined while loading.
  count: string | undefined
  // One short line under the title.
  description: string
  busy?: boolean
  actions: ReactNode
}

// The header of a list: its title and count on the left, its actions (add, import…) on the right.
export function EntityToolbar({ title, count, description, busy = false, actions }: EntityToolbarProps) {
  return (
    <div className="entity-panel__toolbar">
      <div className="entity-panel__heading">
        <h2 className="entity-panel__title">
          {title}
          <span className="entity-panel__count" aria-live="polite">{count ?? '…'}</span>
          {busy && <SpinnerIcon size={16} className="btn__spinner" />}
        </h2>
        <p className="entity-panel__description">{description}</p>
      </div>
      <div className="entity-panel__actions">{actions}</div>
    </div>
  )
}
