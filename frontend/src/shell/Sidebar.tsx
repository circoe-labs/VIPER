import { Link, NavLink } from 'react-router'
import { useState } from 'react'

import { useIsAdmin } from '../auth/RequireAdmin'
import { BrandLogo } from '../brand/BrandLogo'
import { readStorage, writeStorage } from '../lib/storage'
import { IconButton } from '../ui/Button'
import { ChevronDownIcon, PanelLeftIcon } from '../ui/icons'
import { NAVIGATION_SECTIONS, type NavigationSectionId } from './navigation'

const NAV_ID = 'primary-navigation'
const GROUPS_STORAGE_KEY = 'viper.sidebar.groups'

interface SidebarProps {
  collapsed: boolean
  onToggle: () => void
}

function readFoldedGroups(): NavigationSectionId[] {
  try {
    const parsed: unknown = JSON.parse(readStorage(GROUPS_STORAGE_KEY) ?? '[]')
    return Array.isArray(parsed) ? (parsed as NavigationSectionId[]) : []
  } catch {
    return []
  }
}

// Expanded: lockup + labels. Collapsed: mark + icons; labels stay in the accessible name and as tooltips.
// The rail toggle sits next to the logo; each group can be folded on its own (kept in the browser). While the whole
// rail is collapsed every group stays open, so each icon remains reachable.
export function Sidebar({ collapsed, onToggle }: SidebarProps) {
  const admin = useIsAdmin()
  const [folded, setFolded] = useState<NavigationSectionId[]>(readFoldedGroups)
  const sections = NAVIGATION_SECTIONS.filter((section) => !section.adminOnly || admin)

  function toggleGroup(id: NavigationSectionId) {
    const next = folded.includes(id) ? folded.filter((entry) => entry !== id) : [...folded, id]
    writeStorage(GROUPS_STORAGE_KEY, JSON.stringify(next))
    setFolded(next)
  }

  return (
    <aside className="sidebar">
      <div className="sidebar__brand">
        <Link to="/" className="sidebar__home" aria-label="VIPER, retour à l’accueil" title="Accueil">
          <BrandLogo variant={collapsed ? 'mark' : 'lockup'} height={collapsed ? '1.75rem' : '3.25rem'} />
        </Link>
        <IconButton
          icon={PanelLeftIcon}
          label={collapsed ? 'Déplier la navigation' : 'Réduire la navigation'}
          aria-expanded={!collapsed}
          aria-controls={NAV_ID}
          onClick={onToggle}
        />
      </div>
      <nav id={NAV_ID} className="sidebar__nav" aria-label="Navigation principale">
        {sections.map((section) => {
          const open = collapsed || !folded.includes(section.id)
          const items = section.items.filter((item) => !item.adminOnly || admin)
          return (
            <div key={section.id} className="sidebar__group" data-section={section.id}>
              {collapsed ? (
                <p className="visually-hidden" id={`nav-group-${section.id}`}>
                  {section.label}
                </p>
              ) : (
                <button
                  type="button"
                  className="sidebar__group-toggle"
                  aria-expanded={open}
                  aria-controls={`nav-list-${section.id}`}
                  onClick={() => {
                    toggleGroup(section.id)
                  }}
                >
                  <span id={`nav-group-${section.id}`}>{section.label}</span>
                  <ChevronDownIcon size={16} />
                </button>
              )}
              <ul id={`nav-list-${section.id}`} aria-labelledby={`nav-group-${section.id}`} hidden={!open}>
                {items.map(({ path, label, icon: Icon }) => (
                  <li key={path}>
                    <NavLink to={path} end={path === '/'} className="nav-link" title={collapsed ? label : undefined}>
                      <Icon />
                      <span className={collapsed ? 'visually-hidden' : undefined}>{label}</span>
                    </NavLink>
                  </li>
                ))}
              </ul>
            </div>
          )
        })}
      </nav>
    </aside>
  )
}
