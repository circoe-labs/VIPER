import type { ReactNode } from 'react'

import { mascotSource, type MascotName } from '../brand/mascots'
import './page-header.css'

interface PageHeaderProps {
  title: string
  description?: ReactNode
  actions?: ReactNode
  mascot?: MascotName
}

// Top of every routed page: the single <h1>, an optional lead sentence and page-level actions.
export function PageHeader({ title, description, actions, mascot }: PageHeaderProps) {
  return (
    <header className="page-header">
      <div className="page-header__lead">
        {mascot && <img className="page-header__mascot" src={mascotSource(mascot)} alt="" />}
        <div className="page-header__text">
          <h1 className="page-header__title">{title}</h1>
          {description && <p className="page-header__description">{description}</p>}
        </div>
      </div>
      {actions && <div className="page-header__actions">{actions}</div>}
    </header>
  )
}
