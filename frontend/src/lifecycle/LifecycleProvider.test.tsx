import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { Lifecycle } from '../api/lifecycle'
import { company } from '../test/companiesApi'
import { LifecycleProvider } from './LifecycleProvider'
import { useLifecycleMenu } from './useLifecycleMenu'

const ARCHIVED: Lifecycle = { block: 'company_archived', departure_reason: null, holds: [] }
const record = company('Entreprise Test')

// A row that holds the menu and leaves its list as soon as the change is saved.
function Row({ onGone }: { onGone: () => void }) {
  const lifecycle = useLifecycleMenu(onGone)
  return (
    <>
      <button type="button" onClick={() => { lifecycle.open({ type: 'company', id: record.id, name: record.display_name }, 'archive') }}>Archiver la ligne</button>
      {lifecycle.dialog}
    </>
  )
}

function List() {
  const [shown, setShown] = useState(true)
  return shown ? <Row onGone={() => { setShown(false) }} /> : <p>Liste vide</p>
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('LifecycleProvider', () => {
  it('keeps the result on screen after the row that opened it has left', async () => {
    vi.stubGlobal('fetch', vi.fn((_url: string, init?: RequestInit) => {
      const body = init?.method === 'POST' ? { changed: true, cancelled_messages: 1, in_flight_messages: 0, lifecycle: ARCHIVED } : record
      return Promise.resolve(new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } }))
    }))
    const user = userEvent.setup()
    render(
      <QueryClientProvider client={new QueryClient()}>
        <LifecycleProvider>
          <List />
        </LifecycleProvider>
      </QueryClientProvider>,
    )

    await user.click(screen.getByRole('button', { name: 'Archiver la ligne' }))
    await user.click(await screen.findByRole('button', { name: 'Confirmer' }))

    await waitFor(() => { expect(screen.getByText('Liste vide')).toBeInTheDocument() })
    expect(screen.getByText(/1 message non envoyé annulé/)).toBeInTheDocument()
  })
})
