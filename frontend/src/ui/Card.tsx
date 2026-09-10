import { type ReactNode, useId } from 'react'

import './card.css'

interface CardProps {
  title?: string
  actions?: ReactNode
  className?: string
  children: ReactNode
}

// Surface panel. With a title it becomes a labelled region (<section> + <h2>).
export function Card({ title, actions, className, children }: CardProps) {
  const titleId = useId()
  return (
    <section
      className={['card', className].filter(Boolean).join(' ')}
      aria-labelledby={title ? titleId : undefined}
    >
      {title && (
        <header className="card__header">
          <h2 id={titleId} className="card__title">
            {title}
          </h2>
          {actions && <div className="card__actions">{actions}</div>}
        </header>
      )}
      {children}
    </section>
  )
}
