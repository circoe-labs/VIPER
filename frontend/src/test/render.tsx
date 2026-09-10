import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render } from '@testing-library/react'
import { createMemoryRouter, RouterProvider } from 'react-router'
import { vi } from 'vitest'

import { setCsrfToken } from '../api/client'
import { type CurrentUser, SESSION_QUERY_KEY, type SessionState } from '../auth/session'
import { routes } from '../routes'
import { ThemeProvider } from '../theme/ThemeProvider'

// Synthetic signed-in user for component tests.
export const TEST_USER: CurrentUser = {
  id: '01920000-0000-7000-8000-000000000001',
  email: 'pilote.test@example.com',
  display_name: 'Pilote Test',
}
export const TEST_CSRF_TOKEN = 'csrf-token-de-test'

interface RenderAppOptions {
  // Seeded session state (signed in as TEST_USER by default); 'fetch' asks the (stubbed) API like the real app.
  session?: SessionState | 'fetch'
}

export function renderApp(path = '/', { session = { status: 'authenticated', user: TEST_USER } }: RenderAppOptions = {}) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  if (session !== 'fetch') {
    queryClient.setQueryData(SESSION_QUERY_KEY, session)
    if (session.status === 'authenticated') setCsrfToken(TEST_CSRF_TOKEN)
  }
  const router = createMemoryRouter(routes, { initialEntries: [path] })
  const view = render(
    <ThemeProvider>
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>
    </ThemeProvider>,
  )
  return { ...view, router, queryClient }
}

function jsonResponse(status: number, body: unknown): Response {
  if (status === 204) return new Response(null, { status })
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

// Every request answers `status` + `body`.
export function stubFetchJson(status: number, body: unknown) {
  const fetchMock = vi.fn(() => Promise.resolve(jsonResponse(status, body)))
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

// `[status, body]`, or a function of the request URL (query string included) returning one — or a pending/custom
// `Promise<Response>`.
export type ApiReply = readonly [status: number, body?: unknown] | ((url: URL) => ApiReply | Promise<Response>)

function answer(reply: ApiReply | undefined, url: URL): Promise<Response> {
  if (reply === undefined) return Promise.resolve(jsonResponse(404, { detail: 'Not Found' }))
  if (typeof reply === 'function') {
    const result = reply(url)
    return result instanceof Promise ? result : answer(result, url)
  }
  return Promise.resolve(jsonResponse(reply[0], reply[1]))
}

// Routes requests by "METHOD /api/path" (e.g. 'POST /api/auth/login'), matched without the query string; anything
// else answers 404.
export function stubApi(replies: Record<string, ApiReply>) {
  const fetchMock = vi.fn((input: string, init?: RequestInit) => {
    const url = new URL(input, 'http://localhost')
    return answer(replies[`${init?.method ?? 'GET'} ${url.pathname}`], url)
  })
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}
