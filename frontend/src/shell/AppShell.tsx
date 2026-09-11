import { useState } from 'react'
import { Outlet } from 'react-router'

import { CompanyEditorProvider } from '../companies/CompanyEditorProvider'
import { readStorage, writeStorage } from '../lib/storage'
import { ThemeSwitch } from '../theme/ThemeSwitch'
import { GlobalSearch } from './GlobalSearch'
import { Sidebar } from './Sidebar'
import { UserMenu } from './UserMenu'
import './shell.css'

const SIDEBAR_STORAGE_KEY = 'viper.sidebar'

export function AppShell() {
  const [collapsed, setCollapsed] = useState(() => readStorage(SIDEBAR_STORAGE_KEY) === 'collapsed')

  function toggleSidebar() {
    writeStorage(SIDEBAR_STORAGE_KEY, collapsed ? 'expanded' : 'collapsed')
    setCollapsed(!collapsed)
  }

  // Record editors that any page or the global search can open are mounted above the routed page.
  return (
    <CompanyEditorProvider>
      <div className="app-shell" data-sidebar={collapsed ? 'collapsed' : 'expanded'}>
        <a className="skip-link" href="#main-content">
          Aller au contenu
        </a>
        <Sidebar collapsed={collapsed} onToggle={toggleSidebar} />
        <div className="app-shell__body">
          <header className="app-header">
            <div className="app-header__search">
              <GlobalSearch />
            </div>
            <div className="app-header__actions">
              <ThemeSwitch />
              <UserMenu />
            </div>
          </header>
          <main id="main-content" className="app-shell__main" tabIndex={-1}>
            <Outlet />
          </main>
        </div>
      </div>
    </CompanyEditorProvider>
  )
}
