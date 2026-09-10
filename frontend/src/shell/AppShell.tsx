import { useState } from 'react'
import { Outlet } from 'react-router'

import { readStorage, writeStorage } from '../lib/storage'
import { ThemeSwitch } from '../theme/ThemeSwitch'
import { Sidebar } from './Sidebar'
import './shell.css'

const SIDEBAR_STORAGE_KEY = 'viper.sidebar'

export function AppShell() {
  const [collapsed, setCollapsed] = useState(() => readStorage(SIDEBAR_STORAGE_KEY) === 'collapsed')

  function toggleSidebar() {
    writeStorage(SIDEBAR_STORAGE_KEY, collapsed ? 'expanded' : 'collapsed')
    setCollapsed(!collapsed)
  }

  return (
    <div className="app-shell" data-sidebar={collapsed ? 'collapsed' : 'expanded'}>
      <a className="skip-link" href="#main-content">
        Aller au contenu
      </a>
      <Sidebar collapsed={collapsed} onToggle={toggleSidebar} />
      <div className="app-shell__body">
        <header className="app-header">
          {/* Left zone reserved for global search (Task 17). */}
          <div className="app-header__search" />
          <div className="app-header__actions">
            <ThemeSwitch />
            {/* Authenticated user menu lands here with Task 04. */}
          </div>
        </header>
        <main id="main-content" className="app-shell__main" tabIndex={-1}>
          <Outlet />
        </main>
      </div>
    </div>
  )
}
