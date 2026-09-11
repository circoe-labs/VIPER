import { Navigate, type RouteObject } from 'react-router'

import { LoginPage } from './auth/LoginPage'
import { RequireAuth } from './auth/RequireAuth'
import { CompaniesPage } from './companies/CompaniesPage'
import { DatabasePage } from './database/DatabasePage'
import { ExploitationPage } from './exploitation/ExploitationPage'
import { HomePage } from './home/HomePage'
import { ImportPage } from './imports/ImportPage'
import { ProspectionPage } from './prospection/ProspectionPage'
import { AppShell } from './shell/AppShell'
import { SettingsPage } from './settings/SettingsPage'

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

// One page per navigation section (shell/navigation.ts); Exploitation is « Bientôt disponible » on purpose (Task 18):
// no fake operational feature.
const PAGES: RouteObject[] = [
  { path: '/', element: <HomePage /> },
  { path: '/prospection', element: <ProspectionPage /> },
  { path: '/exploitation', element: <ExploitationPage /> },
  { path: '/database/:table?', element: <DatabasePage /> },
  { path: '/settings/:section?', element: <SettingsPage /> },
]

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
      ...PAGES,
      ...SUBPAGES,
      ...devRoutes,
      { path: '*', element: <Navigate to="/" replace /> },
    ],
  },
]
