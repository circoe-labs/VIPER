import { Navigate, useLocation, type RouteObject } from 'react-router'

import { AgendaPage } from './agenda/AgendaPage'
import { LoginPage } from './auth/LoginPage'
import { OAuthConsentPage } from './auth/OAuthConsentPage'
import { RequireAuth } from './auth/RequireAuth'
import { CompaniesPage } from './companies/CompaniesPage'
import { ContactPage } from './contact/ContactPage'
import { DatabasePage } from './database/DatabasePage'
import { MissionDetailPage } from './missions/MissionDetailPage'
import { MissionResultPage } from './missions/MissionResultPage'
import { MissionsPage } from './missions/MissionsPage'
import { HomePage } from './home/HomePage'
import { OrganizationPage } from './organization/OrganizationPage'
import { OpportunitiesPage } from './opportunities/OpportunitiesPage'
import { ImportPage } from './imports/ImportPage'
import { ProspectionPage } from './prospection/ProspectionPage'
import { RobinPage } from './prospection/RobinPage'
import { VerificationPage } from './prospection/VerificationPage'
import { AppShell } from './shell/AppShell'
import { SignupApprovalPage } from './auth/SignupApprovalPage'
import { SignupPage } from './auth/SignupPage'
import { AgentHistoryPage } from './settings/AgentHistoryPage'
import { SettingsPage } from './settings/SettingsPage'
import { WarehousesPage } from './warehouses/WarehousesPage'

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

function ValidatedProspectsRedirect() {
  const location = useLocation()
  const params = new URLSearchParams(location.search)
  params.set('validated_only', 'true')
  params.set('sort', 'company')
  params.set('list', '1')
  return <Navigate to={`/prospection?${params.toString()}${location.hash}`} replace />
}

// One page per navigation section (shell/navigation.ts). Contact replaced Exploitation (Contact port P4): the old
// path redirects, so bookmarks keep working.
const PAGES: RouteObject[] = [
  { path: '/', element: <HomePage /> },
  { path: '/prospection', element: <ProspectionPage /> },
  { path: '/contacts-joignables', element: <ValidatedProspectsRedirect /> },
  { path: '/warehouses', element: <WarehousesPage /> },
  { path: '/contact', element: <ContactPage /> },
  { path: '/missions', element: <MissionsPage /> },
  { path: '/missions/:missionId', element: <MissionDetailPage /> },
  { path: '/missions/:missionId/resultat', element: <MissionResultPage /> },
  // « Autoriser … à accéder à VIPER ? »: where /oauth/authorize sends an MCP connector's person (ChatGPT, Claude…).
  { path: '/autoriser', element: <OAuthConsentPage /> },
  { path: '/agenda', element: <AgendaPage /> },
  { path: '/database/:table?', element: <DatabasePage /> },
  { path: '/organisation', element: <OrganizationPage /> },
  { path: '/historique-agents', element: <AgentHistoryPage /> },
  { path: '/inscriptions/:token', element: <SignupApprovalPage /> },
  { path: '/settings/:section?', element: <SettingsPage /> },
]

// Secondary pages inside a section (the section's navigation item stays current).
const SUBPAGES: RouteObject[] = [
  { path: '/prospection/opportunities', element: <OpportunitiesPage /> },
  { path: '/prospection/companies', element: <CompaniesPage /> },
  { path: '/prospection/import', element: <ImportPage /> },
  { path: '/prospection/verification', element: <VerificationPage /> },
  { path: '/prospection/robin', element: <RobinPage /> },
]

// Everything but /login requires a session (RequireAuth); the API enforces the same rule server-side.
export const routes: RouteObject[] = [
  { path: '/login', element: <LoginPage /> },
  { path: '/inscription', element: <SignupPage /> },
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
      { path: '/exploitation', element: <Navigate to="/contact" replace /> },
      { path: '/agents/*', element: <Navigate to="/missions" replace /> },
      { path: '*', element: <Navigate to="/" replace /> },
    ],
  },
]
