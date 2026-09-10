import { NavLink, Outlet } from 'react-router'

import { ApiStatus } from './ApiStatus'
import { NAVIGATION } from './navigation'
import './shell.css'

export function AppShell() {
  return (
    <div className="app-shell">
      <nav className="app-shell__nav" aria-label="Navigation principale">
        <p className="app-shell__brand">VIPER</p>
        <ul>
          {NAVIGATION.map(({ path, label }) => (
            <li key={path}>
              <NavLink to={path} end={path === '/'}>
                {label}
              </NavLink>
            </li>
          ))}
        </ul>
        <ApiStatus />
      </nav>
      <main className="app-shell__main">
        <Outlet />
      </main>
    </div>
  )
}
