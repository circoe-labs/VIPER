import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'

import { apiGet, apiRequest } from './client'
import { refreshAfterWrite } from './refresh'
import { toolboxKeys } from './toolbox'

// Mirrors backend/app/api/routes/integrations.py (Contact port S8): the integration settings set from Paramètres ›
// Connexions. The OpenAI key is write-only: the browser sends it, the server never answers it (only `set`, `last4`).

export type SettingSource = 'ui' | 'env' | 'default'

export type IntegrationField =
  | 'openai_model'
  | 'openai_base_url'
  | 'openai_timeout_ms'
  | 'openai_max_retries'
  | 'contact_booking_url'
  | 'default_outbound_email'
  | 'toolbox_mail_enabled'
  | 'toolbox_mcp_url'
  | 'toolbox_oauth_redirect_uri'
  | 'contact_dispatch_interval_ms'
  | 'infomaniak_send_allowlist'

export type SettingValue = string | number | boolean | null

export interface IntegrationSetting {
  value: SettingValue
  // `ui`: set on this page; `env`: given by the server's configuration; `default`: built in.
  source: SettingSource
  // What « Rétablir » gives back.
  fallback: SettingValue
  updated_at: string | null
  updated_by: string | null
}

export interface SecretSetting {
  set: boolean
  last4: string | null
  source: SettingSource | null
  updated_at: string | null
  updated_by: string | null
}

export interface Integrations {
  // Concurrency token: sent back with every save.
  version: number
  updated_at: string | null
  updated_by: string | null
  // The stored file was ignored at startup (`unreadable` | `invalid`); the next save rewrites it.
  load_error: 'unreadable' | 'invalid' | null
  storage_path: string
  fields: Record<IntegrationField, IntegrationSetting>
  openai_api_key: SecretSetting
  generation_available: boolean
  toolbox: { enabled: boolean; state: string; configured: boolean }
  dispatch: { running: boolean; active: boolean }
}

// A partial save: only the fields present change; `null` = back to the default. `openai_api_key` replaces the key
// (a string) or clears the one set here (`null`).
export type IntegrationsChanges = Partial<Record<IntegrationField, SettingValue>> & { openai_api_key?: string | null }

export interface KeyCheck {
  ok: boolean
  code: string | null
  model: string | null
  elapsed_ms: number
}

export const integrationsKeys = { all: ['settings', 'integrations'] as const }

// The browser gives up on « Tester la clé » after this long (the server bounds the check to 15 s).
export const KEY_CHECK_DEADLINE_MS = 30_000
// A save may wait for a running scheduled-sending pass to finish before the workers restart (Toolbox timeout).
export const SAVE_DEADLINE_MS = 60_000

export function useIntegrations() {
  return useQuery({
    queryKey: integrationsKeys.all,
    queryFn: ({ signal }) => apiGet<Integrations>('/settings/integrations', signal),
  })
}

export function useIntegrationsMutations() {
  const queryClient = useQueryClient()
  return {
    save: useMutation({
      mutationFn: ({ version, changes }: { version: number; changes: IntegrationsChanges }) =>
        apiRequest<Integrations>('PUT', '/settings/integrations', {
          body: { version, ...changes },
          signal: AbortSignal.timeout(SAVE_DEADLINE_MS),
        }),
      onSuccess: (data) => {
        queryClient.setQueryData(integrationsKeys.all, data)
        // The Toolbox state, the dispatcher and the mail editor's flags (AI available, default sender) follow.
        void refreshAfterWrite(queryClient, [toolboxKeys.status, ['contact', 'messages']])
      },
      // A conflict or a refusal: read the current settings again.
      onError: () => void refreshAfterWrite(queryClient, [integrationsKeys.all]),
    }),
    checkKey: useMutation({
      mutationFn: () =>
        apiRequest<KeyCheck>('POST', '/settings/integrations/openai/check', {
          signal: AbortSignal.timeout(KEY_CHECK_DEADLINE_MS),
        }),
    }),
  }
}
