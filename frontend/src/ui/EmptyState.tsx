import type { ReactNode } from 'react'

import type { IconComponent } from './icons'
import './empty-state.css'

interface EmptyStateProps {
  icon: IconComponent
  title: string
  description?: ReactNode
  action?: ReactNode
}

// Honest "nothing here yet" block: explains the absence of data and offers the next action when there is one.
export function EmptyState({ icon: Icon, title, description, action }: EmptyStateProps) {
  return (
    <div className="empty-state">
      <span className="empty-state__icon">
        <Icon size={24} />
      </span>
      <h2 className="empty-state__title">{title}</h2>
      {description && <p className="empty-state__description">{description}</p>}
      {action && <div className="empty-state__action">{action}</div>}
    </div>
  )
}
