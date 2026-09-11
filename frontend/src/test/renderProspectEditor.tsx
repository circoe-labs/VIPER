import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render } from '@testing-library/react'
import { useState } from 'react'
import { vi } from 'vitest'

import { setCsrfToken } from '../api/client'
import { CurrentUserContext } from '../auth/currentUser'
import type { ProspectListCriteria, Segment } from '../api/prospection'
import { CompanyEditorProvider } from '../companies/CompanyEditorProvider'
import type { ProspectQueue, QueueStep } from '../prospection/queue'
import { ProspectEditor } from '../prospects/ProspectEditor'
import { TEST_CSRF_TOKEN, TEST_USER } from './render'

// The Prospect editor on its own, signed in as TEST_USER, with a queue standing in for the Prospection list (queue.ts
// has its own tests).

export function fakeQueue(ids: string[], segment: Segment = 'never_verified') {
  const criteria: ProspectListCriteria = {
    q: '',
    role: null,
    activity: null,
    referent: null,
    tracking_status: null,
    company: null,
    import_batch: null,
    segment,
    sort: 'name',
  }
  const next = vi.fn((id: string): Promise<QueueStep | null> => {
    const after = ids[ids.indexOf(id) + 1]
    return Promise.resolve(after ? { id: after, page: 1 } : null)
  })
  const queue: ProspectQueue = {
    criteria,
    ids,
    page: 1,
    total: ids.length,
    position: (id) => (ids.includes(id) ? ids.indexOf(id) + 1 : null),
    next,
  }
  return { queue, next }
}

export function renderProspectEditor(target: string, queue: ProspectQueue = fakeQueue([target]).queue) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  setCsrfToken(TEST_CSRF_TOKEN)
  const onNavigate = vi.fn()

  function Harness() {
    const [current, setCurrent] = useState<string | null>(target)
    if (current === null) return <p>Éditeur fermé</p>
    return (
      <ProspectEditor
        target={current}
        queue={queue}
        onNavigate={(next, options) => {
          onNavigate(next, options)
          setCurrent(next)
        }}
      />
    )
  }

  const view = render(
    <QueryClientProvider client={queryClient}>
      <CurrentUserContext value={TEST_USER}>
        <CompanyEditorProvider>
          <Harness />
        </CompanyEditorProvider>
      </CurrentUserContext>
    </QueryClientProvider>,
  )
  return { ...view, queryClient, onNavigate }
}
