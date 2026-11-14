import type { ReactNode } from 'react'
import { Link } from 'react-router'

import { ArrowLeftIcon } from './icons'
import { mascotSource, type MascotName } from '../brand/mascots'
import './page-header.css'

interface PageHeaderProps {
  title: string
  description?: ReactNode
  actions?: ReactNode
  mascot?: MascotName
  // « ← Accueil » link before the title, split from it by a divider; makes the header one compact aligned row.
  back?: { to: string; label: string }
}

// Top of every routed page: the single <h1>, an optional lead sentence and page-level actions.
export function PageHeader({ title, description, actions, mascot, back }: PageHeaderProps) {
  return (
    <header className={back ? 'page-header page-header--dense' : 'page-header'}>
      <div className="page-header__lead">
        {back && (
          <>
            <Link to={back.to} className="page-header__back"><ArrowLeftIcon size={18} />{back.label}</Link>
            <span className="page-header__divider" aria-hidden="true" />
          </>
        )}
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
