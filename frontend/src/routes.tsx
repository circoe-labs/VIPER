import { Navigate, useLocation, useParams, type RouteObject } from 'react-router'

import { AdministrationPage } from './admin/AdministrationPage'
import { AgendaPage } from './agenda/AgendaPage'
import { ForgotPasswordPage } from './auth/ForgotPasswordPage'
import { LoginPage } from './auth/LoginPage'
import { ResetPasswordPage } from './auth/ResetPasswordPage'
import { OAuthConsentPage } from './auth/OAuthConsentPage'
import { RequireAdmin } from './auth/RequireAdmin'
import { RequireAuth } from './auth/RequireAuth'
import { ConfigAiPage } from './config-ai/ConfigAiPage'
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

// The former Entreprises page is the `entity=company` view of Prospection; its own parameters (`created_from`, `q`…)
// are the same names, so the query string travels as is.
function CompaniesRedirect() {
  const location = useLocation()
  const params = new URLSearchParams(location.search)
  params.set('entity', 'company')
  return <Navigate to={`/prospection?${params.toString()}${location.hash}`} replace />
}

// Moves an old path to its new home, keeping the query string and hash (OAuth return parameters).
function LegacyRedirect({ to }: { to: string }) {
  const location = useLocation()
  const { section } = useParams()
  const target = to === '/configuration' && section ? `${to}/${section}` : to
  return <Navigate to={`${target}${location.search}${location.hash}`} replace />
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
  {
    path: '/database/:table?',
    element: (
      <RequireAdmin>
        <DatabasePage />
      </RequireAdmin>
    ),
  },
  { path: '/organisation', element: <OrganizationPage /> },
  {
    path: '/historique-agents',
    element: (
      <RequireAdmin>
        <AgentHistoryPage />
      </RequireAdmin>
    ),
  },
  { path: '/inscriptions/:token', element: <SignupApprovalPage /> },
  // Administration group of the sidebar: administrators only (the API checks every write again).
  {
    path: '/settings/:section?',
    element: (
      <RequireAdmin>
        <SettingsPage />
      </RequireAdmin>
    ),
  },
  {
    path: '/config-ai/:section?',
    element: (
      <RequireAdmin>
        <ConfigAiPage />
      </RequireAdmin>
    ),
  },
  // Configuration group (categories, skills, sources): administrators only, like their API writes.
  {
    path: '/configuration/:section?',
    element: (
      <RequireAdmin>
        <AdministrationPage />
      </RequireAdmin>
    ),
  },
  // Former locations, kept for bookmarks and the Toolbox OAuth return (`?code=…` travels with the redirect).
  { path: '/administration/:section?', element: <LegacyRedirect to="/configuration" /> },
  { path: '/settings/connections', element: <LegacyRedirect to="/config-ai/connections" /> },
  { path: '/settings/mcp', element: <LegacyRedirect to="/config-ai/mcp" /> },
  { path: '/settings/prompt', element: <LegacyRedirect to="/config-ai/prompt" /> },
  { path: '/settings/mission-creator', element: <LegacyRedirect to="/config-ai/mission-creator" /> },
]

// Secondary pages inside a section (the section's navigation item stays current).
const SUBPAGES: RouteObject[] = [
  { path: '/prospection/opportunities', element: <OpportunitiesPage /> },
  { path: '/prospection/companies', element: <CompaniesRedirect /> },
  { path: '/prospection/import', element: <ImportPage /> },
  { path: '/prospection/verification', element: <VerificationPage /> },
  { path: '/prospection/robin', element: <RobinPage /> },
]

// Everything but /login requires a session (RequireAuth); the API enforces the same rule server-side.
export const routes: RouteObject[] = [
  { path: '/login', element: <LoginPage /> },
  { path: '/inscription', element: <SignupPage /> },
  { path: '/mot-de-passe-oublie', element: <ForgotPasswordPage /> },
  { path: '/reinitialisation/:token', element: <ResetPasswordPage /> },
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
      { path: '/exploitation', element: <LegacyRedirect to="/contact" /> },
      { path: '/agents/*', element: <Navigate to="/missions" replace /> },
      { path: '*', element: <Navigate to="/" replace /> },
    ],
  },
]
