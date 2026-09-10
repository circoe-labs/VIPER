import { createContext, use } from 'react'

import type { CurrentUser } from './session'

// Provided by <RequireAuth> with the user it rendered for, so children never see a half-updated session (e.g. while
// signing out, before the guard swaps them for the redirect).
export const CurrentUserContext = createContext<CurrentUser | null>(null)

export function useCurrentUser(): CurrentUser {
  const user = use(CurrentUserContext)
  if (!user) throw new Error('useCurrentUser must be used inside <RequireAuth>')
  return user
}
