import type { ReactNode } from 'react'
import { Navigate, type RouteObject } from 'react-router'

import { LoginPage } from './auth/LoginPage'
import { RequireAuth } from './auth/RequireAuth'
import { DatabasePage } from './database/DatabasePage'
import { AppShell } from './shell/AppShell'
import { SettingsPage } from './settings/SettingsPage'
import { NAVIGATION } from './shell/navigation'
import { PlaceholderPage } from './shell/PlaceholderPage'

// Component showcase for design review; `import.meta.env.DEV` is false in production builds, so the route and
// its chunk are dropped from the bundle and never appear in the navigation.
const devRoutes: RouteObject[] = import.meta.env.DEV
  ? [
      {
        path: '/_dev/ui',
        HydrateFallback: () => null,
        lazy: async () => ({ Component: (await import('./dev/Showcase')).Showcase }),
      },
    ]
  : []

// Sections that have been built; the others keep their "Bientôt disponible" placeholder.
const PAGES: Record<string, { path: string; element: ReactNode }> = {
  '/database': { path: '/database/:table?', element: <DatabasePage /> },
  '/settings': { path: '/settings/:section?', element: <SettingsPage /> },
}

// Everything but /login requires a session (RequireAuth); the API enforces the same rule server-side.
export const routes: RouteObject[] = [
  { path: '/login', element: <LoginPage /> },
  {
    element: (
      <RequireAuth>
        <AppShell />
      </RequireAuth>
    ),
    children: [
      ...NAVIGATION.map(
        ({ path, label, icon }) => PAGES[path] ?? { path, element: <PlaceholderPage title={label} icon={icon} /> },
      ),
      ...devRoutes,
      { path: '*', element: <Navigate to="/" replace /> },
    ],
  },
]
