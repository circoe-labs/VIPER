// Thin typed HTTP client. Every backend call goes through here; UI code never builds URLs itself.
// The session cookie is HttpOnly and travels by itself (same-origin fetch); this module adds the CSRF header on
// unsafe methods and reports expired sessions (backend: doc/adr/0004-authentication-sessions.md).

export class ApiError extends Error {
  readonly status: number
  // The response's JSON `detail` (FastAPI), e.g. a business refusal `{ code, … }`; undefined when absent.
  readonly detail: unknown

  constructor(status: number, message: string, detail?: unknown) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.detail = detail
  }
}

async function errorDetail(response: Response): Promise<unknown> {
  try {
    const body: unknown = await response.json()
    return typeof body === 'object' && body !== null && 'detail' in body ? body.detail : undefined
  } catch {
    return undefined
  }
}

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'

// Must match CSRF_HEADER in backend/app/api/session_cookie.py.
const CSRF_HEADER = 'X-CSRF-Token'

// Session-bound CSRF token from the sign-in / session responses. Memory only: never persisted.
let csrfToken: string | null = null

export function setCsrfToken(token: string | null): void {
  csrfToken = token
}

const unauthorizedListeners = new Set<() => void>()

// `listener` runs when an authenticated call answers 401 (session expired or revoked). Returns the unsubscribe.
export function onUnauthorized(listener: () => void): () => void {
  unauthorizedListeners.add(listener)
  return () => {
    unauthorizedListeners.delete(listener)
  }
}

export interface RequestOptions {
  body?: unknown
  signal?: AbortSignal
  // The caller handles 401 itself (sign-in, session probe): no "session expired" notification.
  anonymous?: boolean
}

export async function apiRequest<T>(
  method: HttpMethod,
  path: `/${string}`,
  { body, signal, anonymous = false }: RequestOptions = {},
): Promise<T> {
  const url = `/api${path}`
  const headers: Record<string, string> = { Accept: 'application/json' }
  if (body !== undefined) headers['Content-Type'] = 'application/json'
  if (method !== 'GET' && csrfToken) headers[CSRF_HEADER] = csrfToken
  const response = await fetch(url, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    signal,
  })
  if (!response.ok) {
    if (response.status === 401 && !anonymous) {
      for (const listener of unauthorizedListeners) listener()
    }
    const message = `${method} ${url} failed with HTTP ${String(response.status)}`
    throw new ApiError(response.status, message, await errorDetail(response))
  }
  return (response.status === 204 ? undefined : await response.json()) as T
}

export function apiGet<T>(path: `/${string}`, signal?: AbortSignal): Promise<T> {
  return apiRequest<T>('GET', path, { signal })
}
