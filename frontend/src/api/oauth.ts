import { useMutation, useQuery } from '@tanstack/react-query'

import { apiGet, apiRequest } from './client'

// Mirrors backend/app/api/routes/oauth.py: the person's decision on a connector's OAuth request (« Autoriser … à
// accéder à VIPER ? »). The connector's own half of the flow (/oauth/*) never goes through the SPA.

export interface OAuthRequest {
  id: string
  client_name: string
  // Where the answer goes (the connector's host), so the person recognises it.
  redirect_host: string
  expires_at: string
}

export interface OAuthDecision {
  // The connector's redirect URI with the code, or `error=access_denied`: the page goes there.
  redirect: string
}

export function useOAuthRequest(id: string | null) {
  return useQuery({
    queryKey: ['oauth', 'request', id],
    queryFn: ({ signal }) => apiGet<OAuthRequest>(`/oauth/requests/${encodeURIComponent(id ?? '')}`, signal),
    enabled: id !== null,
    retry: false,
    refetchOnWindowFocus: false,
  })
}

export function useOAuthDecision(id: string) {
  return useMutation({
    mutationFn: (decision: 'approve' | 'deny') =>
      apiRequest<OAuthDecision>('POST', `/oauth/requests/${encodeURIComponent(id)}/${decision}`),
  })
}
