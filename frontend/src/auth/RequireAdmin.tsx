import type { ReactNode } from 'react'
import { Navigate } from 'react-router'

import { useCurrentUser } from './currentUser'
import type { CurrentUser } from './session'

// Same rule as the API (`require_admin` in routes/mission_categories.py): the platform admin or an « Organisation »
// admin. Finer-grained roles are out of scope; the server checks every write again.
export function isAdmin(user: CurrentUser): boolean {
  return user.is_superadmin || user.role === 'admin'
}

export function useIsAdmin(): boolean {
  return isAdmin(useCurrentUser())
}

// Guards the administration routes: anyone else lands on Accueil (the sidebar does not offer these pages to them).
export function RequireAdmin({ children }: { children: ReactNode }) {
  return useIsAdmin() ? children : <Navigate to="/" replace />
}
