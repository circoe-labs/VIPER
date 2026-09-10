import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render } from '@testing-library/react'
import { createMemoryRouter, RouterProvider } from 'react-router'
import { vi } from 'vitest'

import { routes } from '../routes'
import { ThemeProvider } from '../theme/ThemeProvider'

export function renderApp(path = '/') {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const router = createMemoryRouter(routes, { initialEntries: [path] })
  return render(
    <ThemeProvider>
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>
    </ThemeProvider>,
  )
}

// A non-200 answer for `stubApi` routes.
export class Reply {
  readonly status: number
  readonly body: unknown

  constructor(status: number, body: unknown) {
    this.status = status
    this.body = body
  }
}

// A JSON body (200), a `Reply`, or a function of the request URL returning either.
type RouteHandler = unknown

// Fetch stub answering by exact pathname (`/api/explorer/tables`); a function handler receives the full URL (query
// string included). Unknown paths get a 404.
export function stubApi(routes: Record<string, RouteHandler>) {
  const fetchMock = vi.fn((input: RequestInfo | URL) => {
    const url = new URL(input instanceof Request ? input.url : String(input), 'http://localhost')
    const handler = routes[url.pathname]
    const result: unknown = typeof handler === 'function' ? (handler as (url: URL) => unknown)(url) : handler
    const reply = result instanceof Reply ? result : result === undefined ? new Reply(404, { detail: 'Not found' }) : new Reply(200, result)
    return Promise.resolve(
      new Response(JSON.stringify(reply.body), { status: reply.status, headers: { 'Content-Type': 'application/json' } }),
    )
  })
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

export function stubFetchJson(status: number, body: unknown) {
  const fetchMock = vi.fn(() =>
    Promise.resolve(
      new Response(JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json' },
      }),
    ),
  )
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}
