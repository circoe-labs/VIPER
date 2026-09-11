import { QueryClient, QueryObserver } from '@tanstack/react-query'
import { describe, expect, it, vi } from 'vitest'

import { refreshAfterWrite } from './refresh'

// A slow fake server: a request reads the stored value when it is sent and answers when the test releases it.
function slowServer() {
  let stored = 'avant'
  const pending: (() => void)[] = []
  return {
    write(value: string) {
      stored = value
    },
    read(): Promise<string> {
      const value = stored
      return new Promise((resolve) => {
        pending.push(() => {
          resolve(value)
        })
      })
    },
    // Answers every request in the order it was sent.
    releaseAll() {
      for (const release of pending.splice(0)) release()
    },
    get waiting() {
      return pending.length
    },
  }
}

function watch(server: ReturnType<typeof slowServer>, key: string[]) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const observer = new QueryObserver(queryClient, { queryKey: key, queryFn: () => server.read() })
  const unsubscribe = observer.subscribe(() => undefined)
  return { queryClient, observer, unsubscribe }
}

describe('refreshAfterWrite', () => {
  it('reads again a query whose first request was sent before the write', async () => {
    const server = slowServer()
    const { queryClient, observer, unsubscribe } = watch(server, ['items', 'recherche'])
    expect(server.waiting).toBe(1)

    server.write('après')
    const refreshed = refreshAfterWrite(queryClient, [['items']])
    await vi.waitFor(() => {
      expect(server.waiting).toBe(2)
    })
    // The answer read before the write arrives first; it must not become the current one.
    server.releaseAll()
    await refreshed

    expect(observer.getCurrentResult().data).toBe('après')
    unsubscribe()
  })

  it('refetches an active query holding data and marks the inactive ones stale', async () => {
    const server = slowServer()
    const { queryClient, observer, unsubscribe } = watch(server, ['items', 'liste'])
    server.releaseAll()
    await vi.waitFor(() => {
      expect(observer.getCurrentResult().data).toBe('avant')
    })
    queryClient.setQueryData(['items', 'ancienne recherche'], 'avant')

    server.write('après')
    const refreshed = refreshAfterWrite(queryClient, [['items']])
    await vi.waitFor(() => {
      expect(server.waiting).toBe(1)
    })
    server.releaseAll()
    await refreshed

    expect(observer.getCurrentResult().data).toBe('après')
    expect(queryClient.getQueryState(['items', 'ancienne recherche'])?.isInvalidated).toBe(true)
    unsubscribe()
  })
})
