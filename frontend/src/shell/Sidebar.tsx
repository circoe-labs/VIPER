import { NavLink } from 'react-router'

import { BrandLogo } from '../brand/BrandLogo'
import { IconButton } from '../ui/Button'
import { PanelLeftIcon } from '../ui/icons'
import { ApiStatus } from './ApiStatus'
import { NAVIGATION } from './navigation'

const NAV_ID = 'primary-navigation'

interface SidebarProps {
  collapsed: boolean
  onToggle: () => void
}

// Expanded: lockup + labels. Collapsed: mark + icons; labels stay in the accessible name and as tooltips.
export function Sidebar({ collapsed, onToggle }: SidebarProps) {
  return (
    <aside className="sidebar">
      <div className="sidebar__brand">
        <BrandLogo variant={collapsed ? 'mark' : 'lockup'} height={collapsed ? '1.75rem' : '4.5rem'} />
      </div>
      <nav id={NAV_ID} className="sidebar__nav" aria-label="Navigation principale">
        <ul>
          {NAVIGATION.map(({ path, label, icon: Icon }) => (
            <li key={path}>
              <NavLink to={path} end={path === '/'} className="nav-link" title={collapsed ? label : undefined}>
                <Icon />
                <span className={collapsed ? 'visually-hidden' : undefined}>{label}</span>
              </NavLink>
            </li>
          ))}
        </ul>
      </nav>
      <div className="sidebar__footer">
        <ApiStatus compact={collapsed} />
        <IconButton
          icon={PanelLeftIcon}
          label={collapsed ? 'Déplier la navigation' : 'Réduire la navigation'}
          aria-expanded={!collapsed}
          aria-controls={NAV_ID}
          onClick={onToggle}
        />
      </div>
    </aside>
  )
}
