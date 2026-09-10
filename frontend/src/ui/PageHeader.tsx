import type { ReactNode } from 'react'

import './page-header.css'

interface PageHeaderProps {
  title: string
  description?: ReactNode
  actions?: ReactNode
}

// Top of every routed page: the single <h1>, an optional lead sentence and page-level actions.
export function PageHeader({ title, description, actions }: PageHeaderProps) {
  return (
    <header className="page-header">
      <div className="page-header__text">
        <h1 className="page-header__title">{title}</h1>
        {description && <p className="page-header__description">{description}</p>}
      </div>
      {actions && <div className="page-header__actions">{actions}</div>}
    </header>
  )
}
