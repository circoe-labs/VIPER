import { useQueryClient } from '@tanstack/react-query'
import { type ReactNode, useEffect } from 'react'
import { Navigate, useLocation } from 'react-router'

import { onUnauthorized } from '../api/client'
import { Button } from '../ui/Button'
import { AlertIcon, SpinnerIcon } from '../ui/icons'
import { CurrentUserContext } from './currentUser'
import type { LoginState } from './loginState'
import { signOutLocally, useSession } from './session'
import './auth.css'

// Renders `children` only for a signed-in user. Anonymous visitors go to /login, which brings them back to the URL
// they asked for (except after an explicit sign-out). Any 401 from the API while inside ends the session here.
export function RequireAuth({ children }: { children: ReactNode }) {
  const session = useSession()
  const queryClient = useQueryClient()
  const location = useLocation()

  useEffect(
    () =>
      onUnauthorized(() => {
        signOutLocally(queryClient, 'expired')
      }),
    [queryClient],
  )

  if (session.isPending) {
    return (
      <div className="auth-status" role="status">
        <SpinnerIcon size={24} className="auth-status__spinner" />
        Chargement de votre session…
      </div>
    )
  }
  if (session.isError) {
    return (
      <div className="auth-status" role="alert">
        <AlertIcon size={24} />
        <p>Impossible de joindre le serveur VIPER.</p>
        <Button
          onClick={() => {
            void session.refetch()
          }}
        >
          Réessayer
        </Button>
      </div>
    )
  }
  if (session.data.status === 'anonymous') {
    const { reason } = session.data
    const { pathname, search, hash } = location
    const state: LoginState = { reason, from: reason === 'signed-out' ? undefined : { pathname, search, hash } }
    return <Navigate to="/login" replace state={state} />
  }
  return <CurrentUserContext value={session.data.user}>{children}</CurrentUserContext>
}
