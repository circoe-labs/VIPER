import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'

import { apiGet, apiRequest } from './client'
import { refreshAfterWrite } from './refresh'

// Mirrors backend/app/api/routes/toolbox.py: the CIRCOE Toolbox connection (Contact port S6). No token ever reaches
// the browser; the OAuth return lands on /settings/connections, which posts its query to the API (session + CSRF).

export type ToolboxState = 'disabled' | 'not_configured' | 'disconnected' | 'connected' | 'expired'

export interface ToolboxStatus {
  enabled: boolean
  state: ToolboxState
  configured: boolean
  connected: boolean
  // Names of the missing server settings (never a value).
  missing: string[]
  toolbox_origin: string | null
  connected_at: string | null
  connected_by: string | null
  expires_at: string | null
  // The Toolbox names no mailbox in its answer: null for now.
  account_label: string | null
  last_error: { code: string; at: string } | null
  // Obsolete Infomaniak drafts still to delete.
  cleanups: { pending: number; failing: number }
  // The scheduled sending (S7): `running` = the worker runs in the API process; `active` = and the Toolbox is
  // connected (a scheduled message really leaves). `unconfirmed` = sends a person may have to settle.
  dispatch: {
    running: boolean
    active: boolean
    interval_seconds: number
    last_pass_at: string | null
    last_outcome: 'ok' | 'error' | null
    scheduled: number
    unconfirmed: number
  }
}

// The query of the OAuth return (`/settings/connections?code=…&state=…&iss=…` or `?error=…&state=…`).
export interface ToolboxCallback {
  state: string
  code: string
  iss: string
  error: string
}

export const toolboxKeys = { status: ['toolbox', 'status'] as const }

// The browser gives up after this long on a connection call (the server bounds each Toolbox request, 20 s by default;
// starting a connection makes up to four of them).
export const TOOLBOX_DEADLINE_MS = 90_000

// The integration settings (api/integrations.ts, S8): connecting turns the Toolbox on, « Se déconnecter » turns it off.
const INTEGRATIONS_KEY = ['settings', 'integrations'] as const

// Where the Toolbox sends the browser back: this very page, as the browser sees it (S8). The server keeps it unless a
// value was typed in « Paramètres avancés ».
export function connectionReturnAddress(): string {
  return `${window.location.origin}/settings/connections`
}

export function useToolboxStatus() {
  return useQuery({
    queryKey: toolboxKeys.status,
    queryFn: ({ signal }) => apiGet<ToolboxStatus>('/settings/toolbox', signal),
  })
}

export function useToolboxMutations() {
  const queryClient = useQueryClient()
  const settled = (status: ToolboxStatus) => {
    queryClient.setQueryData(toolboxKeys.status, status)
    // The mail editor's « Toolbox connectée » flag comes with the message sequence.
    void refreshAfterWrite(queryClient, [['contact', 'messages'], INTEGRATIONS_KEY])
  }
  return {
    // « Se connecter à CIRCOE Toolbox »: turns the integration on and sends this page's address, then answers the
    // Toolbox URL the browser goes to (the Toolbox, then Infomaniak).
    connect: useMutation({
      mutationFn: () =>
        apiRequest<{ authorization_url: string }>('POST', '/settings/toolbox/connect', {
          body: { redirect_uri: connectionReturnAddress() },
          signal: AbortSignal.timeout(TOOLBOX_DEADLINE_MS),
        }),
      // The settings changed (turned on, return address); a failure is recorded server-side (`last_error`).
      onSettled: () => void refreshAfterWrite(queryClient, [toolboxKeys.status, INTEGRATIONS_KEY]),
    }),
    callback: useMutation({
      mutationFn: (params: ToolboxCallback) =>
        apiRequest<ToolboxStatus>('POST', '/settings/toolbox/callback', {
          body: params,
          signal: AbortSignal.timeout(TOOLBOX_DEADLINE_MS),
        }),
      onSuccess: settled,
      // A failure is recorded server-side (`last_error`): read the state again.
      onError: () => void refreshAfterWrite(queryClient, [toolboxKeys.status]),
    }),
    // « Se déconnecter »: forgets the token and turns the integration off (S8).
    forget: useMutation({
      mutationFn: () =>
        apiRequest<ToolboxStatus>('POST', '/settings/toolbox/forget', { signal: AbortSignal.timeout(TOOLBOX_DEADLINE_MS) }),
      onSuccess: settled,
      onError: () => void refreshAfterWrite(queryClient, [toolboxKeys.status, INTEGRATIONS_KEY]),
    }),
  }
}
