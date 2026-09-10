import { type QueryClient, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'

import { ApiError, apiRequest, setCsrfToken } from '../api/client'

// Mirror backend `UserResponse` / `SessionResponse` (backend/app/api/routes/auth.py).
export interface CurrentUser {
  id: string
  email: string
  display_name: string
}

export interface SessionResponse {
  user: CurrentUser
  csrf_token: string
}

// Why the visitor is anonymous: first visit, session expired/revoked server-side, or explicit sign-out.
export type AnonymousReason = 'initial' | 'expired' | 'signed-out'

export type SessionState = { status: 'authenticated'; user: CurrentUser } | { status: 'anonymous'; reason: AnonymousReason }

export interface Credentials {
  email: string
  password: string
}

export const SESSION_QUERY_KEY = ['auth', 'session'] as const

async function fetchSession(signal: AbortSignal): Promise<SessionState> {
  try {
    const session = await apiRequest<SessionResponse>('GET', '/auth/session', { signal, anonymous: true })
    setCsrfToken(session.csrf_token)
    return { status: 'authenticated', user: session.user }
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) {
      setCsrfToken(null)
      return { status: 'anonymous', reason: 'initial' }
    }
    throw error
  }
}

// Asked once per page load; afterwards the state changes only through sign-in, sign-out or a 401 (signOutLocally).
export function useSession() {
  return useQuery({
    queryKey: SESSION_QUERY_KEY,
    queryFn: ({ signal }) => fetchSession(signal),
    staleTime: Infinity,
    refetchOnWindowFocus: false,
  })
}

// Forgets the session and every cached server response (they belong to the previous session).
export function signOutLocally(queryClient: QueryClient, reason: Exclude<AnonymousReason, 'initial'>): void {
  const anonymous: SessionState = { status: 'anonymous', reason }
  setCsrfToken(null)
  queryClient.setQueryData(SESSION_QUERY_KEY, anonymous)
  queryClient.removeQueries({ predicate: (query) => query.queryKey[0] !== SESSION_QUERY_KEY[0] })
}

export function useLogin() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (credentials: Credentials) =>
      apiRequest<SessionResponse>('POST', '/auth/login', { body: credentials, anonymous: true }),
    onSuccess: (session) => {
      const authenticated: SessionState = { status: 'authenticated', user: session.user }
      setCsrfToken(session.csrf_token)
      queryClient.setQueryData(SESSION_QUERY_KEY, authenticated)
    },
  })
}

export function useLogout() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: () => apiRequest<undefined>('POST', '/auth/logout'),
    onSuccess: () => {
      signOutLocally(queryClient, 'signed-out')
    },
  })
}
