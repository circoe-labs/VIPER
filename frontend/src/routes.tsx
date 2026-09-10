import { Navigate, type RouteObject } from 'react-router'

import { AppShell } from './shell/AppShell'
import { NAVIGATION } from './shell/navigation'
import { PlaceholderPage } from './shell/PlaceholderPage'

export const routes: RouteObject[] = [
  {
    element: <AppShell />,
    children: [
      ...NAVIGATION.map(({ path, label }) => ({ path, element: <PlaceholderPage title={label} /> })),
      { path: '*', element: <Navigate to="/" replace /> },
    ],
  },
]
