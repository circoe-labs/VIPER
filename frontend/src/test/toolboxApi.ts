import { vi } from 'vitest'

import type { ToolboxCallback, ToolboxStatus } from '../api/toolbox'

// In-memory stand-in for /api/settings/toolbox (backend/app/api/routes/toolbox.py) for component tests, layered over
// the fetch stub already installed (other routes go to it). Synthetic values only; never a token.

export const TOOLBOX_ORIGIN = 'https://toolbox.exemple.example'
export const AUTHORIZE_URL = `${TOOLBOX_ORIGIN}/authorize?state=etat-de-test`

export function toolboxStatus(fields: Partial<ToolboxStatus> = {}): ToolboxStatus {
  return {
    enabled: true,
    state: 'disconnected',
    configured: true,
    connected: false,
    missing: [],
    toolbox_origin: TOOLBOX_ORIGIN,
    connected_at: null,
    connected_by: null,
    expires_at: null,
    account_label: null,
    last_error: null,
    cleanups: { pending: 0, failing: 0 },
    ...fields,
  }
}

export const CONNECTED = toolboxStatus({
  state: 'connected',
  connected: true,
  connected_at: '2026-10-01T07:00:00+00:00',
  connected_by: 'Pilote Test',
  expires_at: '2026-10-31T07:00:00+00:00',
})

interface ToolboxStubOptions {
  status?: ToolboxStatus
  // A refusal code answered by `POST …/callback` (e.g. `toolbox_state_invalid`), else success.
  callbackRefusal?: string
  // A refusal code answered by `POST …/connect`.
  connectRefusal?: string
}

function json(status: number, body: unknown): Promise<Response> {
  return Promise.resolve(new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } }))
}

export function stubToolboxApi(options: ToolboxStubOptions = {}) {
  const previous = globalThis.fetch
  const state = { status: options.status ?? toolboxStatus() }
  const callbacks: ToolboxCallback[] = []
  const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(input instanceof Request ? input.url : String(input), 'http://localhost')
    const method = init?.method ?? 'GET'
    if (!url.pathname.startsWith('/api/settings/toolbox')) return previous(input, init)
    const action = url.pathname.slice('/api/settings/toolbox'.length)
    if (method === 'GET' && action === '') return json(200, state.status)
    if (method === 'POST' && action === '/connect') {
      return options.connectRefusal
        ? json(502, { detail: { code: options.connectRefusal, message: options.connectRefusal } })
        : json(200, { authorization_url: AUTHORIZE_URL })
    }
    if (method === 'POST' && action === '/callback') {
      callbacks.push(JSON.parse(typeof init?.body === 'string' ? init.body : '{}') as ToolboxCallback)
      if (options.callbackRefusal) {
        state.status = { ...state.status, last_error: { code: options.callbackRefusal, at: '2026-10-01T08:00:00+00:00' } }
        return json(400, { detail: { code: options.callbackRefusal, message: options.callbackRefusal } })
      }
      state.status = CONNECTED
      return json(200, state.status)
    }
    if (method === 'POST' && action === '/forget') {
      state.status = toolboxStatus()
      return json(200, state.status)
    }
    return json(404, { detail: 'Not Found' })
  })
  vi.stubGlobal('fetch', fetchMock)
  return { fetchMock, callbacks, state }
}
