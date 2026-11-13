import { NavLink } from 'react-router'

import { useIsAdmin } from '../auth/RequireAdmin'
import { BrandLogo } from '../brand/BrandLogo'
import { IconButton } from '../ui/Button'
import { PanelLeftIcon } from '../ui/icons'
import { ApiStatus } from './ApiStatus'
import { NAVIGATION_SECTIONS } from './navigation'

const NAV_ID = 'primary-navigation'

interface SidebarProps {
  collapsed: boolean
  onToggle: () => void
}

// Expanded: lockup + labels. Collapsed: mark + icons; labels stay in the accessible name and as tooltips.
// Destinations are grouped (main / configuration / administration); each group is a named list so a screen reader
// announces it, and the headings are drawn only when the sidebar is expanded (a divider takes their place).
export function Sidebar({ collapsed, onToggle }: SidebarProps) {
  const admin = useIsAdmin()
  const sections = NAVIGATION_SECTIONS.filter((section) => !section.adminOnly || admin)
  return (
    <aside className="sidebar">
      <div className="sidebar__brand">
        <BrandLogo variant={collapsed ? 'mark' : 'lockup'} height={collapsed ? '1.75rem' : '4.5rem'} />
      </div>
      <nav id={NAV_ID} className="sidebar__nav" aria-label="Navigation principale">
        {sections.map((section) => (
          <div key={section.id} className="sidebar__group" data-section={section.id}>
            <p className={collapsed ? 'visually-hidden' : 'sidebar__group-title'} id={`nav-group-${section.id}`}>
              {section.label}
            </p>
            <ul aria-labelledby={`nav-group-${section.id}`}>
              {section.items.map(({ path, label, icon: Icon }) => (
                <li key={path}>
                  <NavLink to={path} end={path === '/'} className="nav-link" title={collapsed ? label : undefined}>
                    <Icon />
                    <span className={collapsed ? 'visually-hidden' : undefined}>{label}</span>
                  </NavLink>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </nav>
      {!collapsed && <details className="sidebar__help"><summary>Aide</summary><p>Rechercher : Ctrl+K. Ouvrez une fiche pour modifier ses informations. Retrouvez les prospects validés dans Prospection.</p></details>}
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
