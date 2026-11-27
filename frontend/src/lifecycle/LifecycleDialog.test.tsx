import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { Lifecycle } from '../api/lifecycle'
import { company } from '../test/companiesApi'
import { LifecycleDialog } from './LifecycleDialog'
import { statusChoices } from './model'

const FREE: Lifecycle = { block: null, departure_reason: null, holds: [] }
const EXCLUDED: Lifecycle = {
  block: 'company_excluded',
  departure_reason: null,
  holds: [{ kind: 'exclusion', scope: 'company', reason: 'Pas d’angle', placed_at: '2026-09-01T09:00:00Z', placed_by: 'Personne Test' }],
}

function answer(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('statusChoices', () => {
  it('offers a departure to a person only, and the way back from what is in place', () => {
    expect(statusChoices(FREE, 'prospect', false).map((choice) => choice.id)).toEqual(['depart-retired', 'depart-left_company', 'depart-other', 'exclude', 'archive'])
    expect(statusChoices(FREE, 'prospect', true)[0]?.action).toBe('return')
    expect(statusChoices(EXCLUDED, 'company', false).map((choice) => choice.action)).toEqual(['reinstate', 'archive'])
    // The company's exclusion is not the person's own: it is lifted from the company.
    expect(statusChoices(EXCLUDED, 'prospect', false).map((choice) => choice.action)).toContain('exclude')
  })
})

describe('LifecycleDialog', () => {
  it('asks for a reason before excluding, says what was cancelled, and shows a refusal', async () => {
    const record = company('Entreprise Test')
    const posted: unknown[] = []
    let refuse = true
    vi.stubGlobal('fetch', vi.fn((_url: string, init?: RequestInit) => {
      if (init?.method !== 'POST') return Promise.resolve(answer(record))
      posted.push(JSON.parse(init.body as string))
      if (refuse) return Promise.resolve(answer({ detail: 'boom' }, 500))
      return Promise.resolve(answer({ changed: true, cancelled_messages: 2, in_flight_messages: 0, lifecycle: EXCLUDED }))
    }))
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const user = userEvent.setup()
    render(
      <QueryClientProvider client={new QueryClient()}>
        <LifecycleDialog subject={{ type: 'company', id: record.id, name: record.display_name }} intent="status" onClose={() => undefined} />
      </QueryClientProvider>,
    )

    await user.click(await screen.findByRole('radio', { name: 'Exclure temporairement de la prospection' }))
    const confirm = screen.getByRole('button', { name: 'Confirmer' })
    expect(confirm).toBeDisabled()
    await user.type(screen.getByRole('textbox'), 'Pas d’angle')
    await user.click(confirm)
    expect(await screen.findByRole('alert')).toHaveTextContent('HTTP 500')

    refuse = false
    await user.click(confirm)
    await waitFor(() => { expect(screen.getByText(/2 messages non envoyés annulés/)).toBeInTheDocument() })
    expect(posted.at(-1)).toEqual({ action: 'exclude', reason: 'Pas d’angle' })
  })
})
