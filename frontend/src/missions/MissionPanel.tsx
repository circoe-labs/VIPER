import { type ReactNode, useId } from 'react'

import type { IconComponent } from '../ui/icons'
import type { MissionHue } from './missionAccent'
import './missionUi.css'

interface MissionPanelProps {
  title: string
  icon?: IconComponent
  hue?: MissionHue
  // Right of the title: a legend, a period switch, a zoom.
  actions?: ReactNode
  // Heading level, so a panel nests correctly under the page h1 / a tab h2.
  level?: 2 | 3
  className?: string
  children: ReactNode
}

// Accent card of the Mission screens: a tinted surface, an icon tile, a title. A named region (section + heading).
// For a clickable card (the list tile) put `className="mui-accent"` + `data-hue` on the element itself instead.
export function MissionPanel({ title, icon: Icon, hue = 'neutral', actions, level = 3, className, children }: MissionPanelProps) {
  const titleId = useId()
  const Heading = level === 2 ? 'h2' : 'h3'
  return (
    <section
      className={['mui-panel', 'mui-accent', className].filter(Boolean).join(' ')}
      data-hue={hue}
      aria-labelledby={titleId}
    >
      <header className="mui-panel__header">
        {Icon && (
          <span className="mui-icon-tile" aria-hidden="true">
            <Icon size={18} />
          </span>
        )}
        <Heading id={titleId} className="mui-panel__title">
          {title}
        </Heading>
        {actions && <div className="mui-panel__actions">{actions}</div>}
      </header>
      {children}
    </section>
  )
}
