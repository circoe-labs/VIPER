import type { ReactNode } from 'react'
import { Navigate, type RouteObject } from 'react-router'

import { LoginPage } from './auth/LoginPage'
import { RequireAuth } from './auth/RequireAuth'
import { CompaniesPage } from './companies/CompaniesPage'
import { DatabasePage } from './database/DatabasePage'
import { ExploitationPage } from './exploitation/ExploitationPage'
import { ImportPage } from './imports/ImportPage'
import { ProspectionPage } from './prospection/ProspectionPage'
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
  '/prospection': { path: '/prospection', element: <ProspectionPage /> },
  // Coming soon on purpose (Task 18): no fake operational feature.
  '/exploitation': { path: '/exploitation', element: <ExploitationPage /> },
  '/database': { path: '/database/:table?', element: <DatabasePage /> },
  '/settings': { path: '/settings/:section?', element: <SettingsPage /> },
}

// Secondary pages inside a section (the section's navigation item stays current).
const SUBPAGES: RouteObject[] = [
  { path: '/prospection/companies', element: <CompaniesPage /> },
  { path: '/prospection/import', element: <ImportPage /> },
]

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
      ...SUBPAGES,
      ...devRoutes,
      { path: '*', element: <Navigate to="/" replace /> },
    ],
  },
]
