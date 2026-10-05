import { vi } from 'vitest'

import type {
  IntegrationField,
  Integrations,
  IntegrationSetting,
  KeyCheck,
  SecretSetting,
  SettingValue,
} from '../api/integrations'

// In-memory stand-in for /api/settings/integrations (backend/app/api/routes/integrations.py, S8) for component tests,
// layered over the fetch stub already installed. Like the server: partial saves, `null` = back to the fallback, the
// `version` concurrency token, a write-only key (never answered). Synthetic values only.

const DEFAULTS: Record<IntegrationField, SettingValue> = {
  openai_model: null,
  openai_base_url: 'https://api.openai.com/v1',
  openai_timeout_ms: 60_000,
  openai_max_retries: 2,
  contact_booking_url: null,
  contact_initial_prompt: null,
  default_outbound_email: null,
  toolbox_mail_enabled: false,
  toolbox_mcp_url: 'https://toolbox.exemple.example/mcp',
  toolbox_oauth_redirect_uri: null,
  contact_dispatch_enabled: true,
  contact_dispatch_interval_ms: 30_000,
  infomaniak_send_allowlist: null,
}

const NO_KEY: SecretSetting = { set: false, last4: null, source: null, updated_at: null, updated_by: null }
const STAMP = '2026-10-01T08:00:00+00:00'

function setting(field: IntegrationField, value: SettingValue = DEFAULTS[field]): IntegrationSetting {
  return { value, source: 'default', fallback: DEFAULTS[field], updated_at: null, updated_by: null }
}

export function integrations(
  fields: Partial<Record<IntegrationField, Partial<IntegrationSetting>>> = {},
  extra: Partial<Integrations> = {},
): Integrations {
  const all = Object.fromEntries(
    (Object.keys(DEFAULTS) as IntegrationField[]).map((field) => [field, { ...setting(field), ...fields[field] }]),
  ) as Record<IntegrationField, IntegrationSetting>
  return {
    version: 0,
    updated_at: null,
    updated_by: null,
    load_error: null,
    load_dropped: [],
    storage_path: 'C:\\Users\\pilote\\.viper\\runtime-settings.json',
    fields: all,
    openai_api_key: NO_KEY,
    generation_available: false,
    initial_prompt_default: 'Tu es l’assistant de prospection de Circoe (texte par défaut de test).',
    toolbox: { enabled: false, state: 'disabled', configured: false },
    dispatch: { running: false, active: false, reason: 'toolbox_disabled', scheduled_count: 0, overdue_count: 0 },
    ...extra,
  }
}

interface IntegrationsStubOptions {
  initial?: Integrations
  // `PUT` answers 422 `invalid` for this field (the server's rule), whatever the value.
  refuseField?: IntegrationField | 'openai_api_key'
  // With `refuseField`: the refusal's `reason` (e.g. `required_with_base_url`).
  refuseReason?: string
  // `PUT` answers 503 `settings_storage_unavailable`.
  storageUnavailable?: boolean
  // `PUT` answers 409 `conflict`.
  conflict?: boolean
  // The answer of « Tester la clé ».
  check?: KeyCheck
}

function json(status: number, body: unknown): Promise<Response> {
  return Promise.resolve(new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } }))
}

export function stubIntegrationsApi(options: IntegrationsStubOptions = {}) {
  const previous = globalThis.fetch
  const state = { data: options.initial ?? integrations() }
  const puts: Record<string, unknown>[] = []
  const checks: number[] = []
  const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(input instanceof Request ? input.url : String(input), 'http://localhost')
    const method = init?.method ?? 'GET'
    if (!url.pathname.startsWith('/api/settings/integrations')) return previous(input, init)
    if (method === 'GET' && url.pathname === '/api/settings/integrations') return json(200, state.data)
    if (method === 'POST' && url.pathname === '/api/settings/integrations/openai/check') {
      checks.push(Date.now())
      return json(200, options.check ?? { ok: true, code: null, model: 'modele-test', elapsed_ms: 420 })
    }
    if (method === 'PUT' && url.pathname === '/api/settings/integrations') {
      const body = JSON.parse(typeof init?.body === 'string' ? init.body : '{}') as Record<string, unknown>
      puts.push(body)
      if (options.conflict || body.version !== state.data.version) {
        return json(409, { detail: { code: 'conflict', message: 'changed' } })
      }
      if (options.storageUnavailable) return json(503, { detail: { code: 'settings_storage_unavailable', message: 'unwritable' } })
      if (options.refuseField && (options.refuseField in body || options.refuseReason)) {
        return json(422, { detail: { code: 'invalid', message: 'refused', field: options.refuseField, reason: options.refuseReason } })
      }
      const next: Integrations = structuredClone(state.data)
      for (const [name, value] of Object.entries(body)) {
        if (name === 'version') continue
        if (name === 'openai_api_key') {
          next.openai_api_key =
            value === null
              ? NO_KEY
              : { set: true, last4: (value as string).slice(-4), source: 'ui', updated_at: STAMP, updated_by: 'Pilote Test' }
          continue
        }
        const field = name as IntegrationField
        next.fields[field] =
          value === null
            ? { ...next.fields[field], value: next.fields[field].fallback, source: 'default', updated_at: null, updated_by: null }
            : { ...next.fields[field], value: value as SettingValue, source: 'ui', updated_at: STAMP, updated_by: 'Pilote Test' }
      }
      next.version += 1
      next.updated_at = STAMP
      next.updated_by = 'Pilote Test'
      next.generation_available = next.openai_api_key.set && Boolean(next.fields.openai_model.value)
      // S9: the switch off stops the sending; on again, it waits for the Toolbox (this fake never runs a worker).
      if (next.fields.contact_dispatch_enabled.value === false) {
        next.dispatch = { ...next.dispatch, running: false, active: false, reason: 'disabled' }
      } else if (next.dispatch.reason === 'disabled') {
        next.dispatch = { ...next.dispatch, reason: 'toolbox_disconnected' }
      }
      state.data = next
      return json(200, next)
    }
    return json(404, { detail: 'Not Found' })
  })
  vi.stubGlobal('fetch', fetchMock)
  return { fetchMock, state, puts, checks }
}
