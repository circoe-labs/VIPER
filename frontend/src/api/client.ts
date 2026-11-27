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

// No answer within the deadline. A read can simply be asked again; the outcome of a write is unknown.
export class RequestTimeoutError extends Error {
  readonly timeoutMs: number

  constructor(request: string, timeoutMs: number) {
    super(`${request} had no answer after ${String(timeoutMs / 1000)} s`)
    this.name = 'RequestTimeoutError'
    this.timeoutMs = timeoutMs
  }
}

// Reads always carry a deadline: no screen waits forever. A write carries the one its caller gives (`timeoutMs` or a
// `signal`): imports and AI calls last minutes.
export const READ_TIMEOUT_MS = 30_000
export const SAVE_TIMEOUT_MS = 30_000

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
  // JSON-encoded, except FormData (multipart uploads) which is sent as is.
  body?: unknown
  signal?: AbortSignal
  // Deadline of the whole answer; a GET has READ_TIMEOUT_MS when none is given.
  timeoutMs?: number
  // The caller handles 401 itself (sign-in, session probe): no "session expired" notification.
  anonymous?: boolean
}

export async function apiRequest<T>(
  method: HttpMethod,
  path: `/${string}`,
  { body, signal, timeoutMs = method === 'GET' ? READ_TIMEOUT_MS : undefined, anonymous = false }: RequestOptions = {},
): Promise<T> {
  const url = `/api${path}`
  const headers: Record<string, string> = { Accept: 'application/json' }
  const multipart = body instanceof FormData
  // The browser sets the multipart Content-Type (with its boundary) itself.
  if (body !== undefined && !multipart) headers['Content-Type'] = 'application/json'
  if (method !== 'GET' && csrfToken) headers[CSRF_HEADER] = csrfToken
  return withDeadline(`${method} ${url}`, timeoutMs, signal, async (deadline) => {
    const response = await fetch(url, {
      method,
      headers,
      body: body === undefined ? undefined : multipart ? body : JSON.stringify(body),
      signal: deadline,
    })
    if (!response.ok) throw await failure(method, url, response, anonymous)
    return (response.status === 204 ? undefined : await response.json()) as T
  })
}

// Runs `send` (the request and the reading of its body) under `timeoutMs`, keeping the caller's own cancellation. A
// deadline that passes is logged (without the query string) and reported as RequestTimeoutError.
async function withDeadline<T>(
  request: string,
  timeoutMs: number | undefined,
  signal: AbortSignal | undefined,
  send: (signal: AbortSignal | undefined) => Promise<T>,
): Promise<T> {
  if (timeoutMs === undefined) return send(signal)
  const controller = new AbortController()
  const cancel = () => {
    controller.abort(signal?.reason)
  }
  if (signal?.aborted) cancel()
  signal?.addEventListener('abort', cancel)
  const expired = new RequestTimeoutError(request.split('?')[0] ?? request, timeoutMs)
  const timer = setTimeout(() => {
    controller.abort(expired)
  }, timeoutMs)
  try {
    return await send(controller.signal)
  } catch (error) {
    if (controller.signal.reason !== expired) throw error
    console.warn(expired.message)
    throw expired
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', cancel)
  }
}

async function failure(method: HttpMethod, url: string, response: Response, anonymous: boolean): Promise<ApiError> {
  if (response.status === 401 && !anonymous) {
    for (const listener of unauthorizedListeners) listener()
  }
  const message = `${method} ${url} failed with HTTP ${String(response.status)}`
  return new ApiError(response.status, message, await errorDetail(response))
}

export interface DownloadedFile {
  blob: Blob
  // From the response's Content-Disposition; null when the server named none.
  filename: string | null
}

// A file download (GET, the session cookie authenticates it): the body as a Blob and its file name.
export async function apiDownload(path: `/${string}`, signal?: AbortSignal): Promise<DownloadedFile> {
  const url = `/api${path}`
  const response = await fetch(url, { signal })
  if (!response.ok) throw await failure('GET', url, response, false)
  const disposition = response.headers.get('Content-Disposition') ?? ''
  const filename = /filename="([^"]+)"/.exec(disposition)?.[1] ?? null
  return { blob: await response.blob(), filename }
}

export function apiGet<T>(path: `/${string}`, signal?: AbortSignal): Promise<T> {
  return apiRequest<T>('GET', path, { signal })
}
