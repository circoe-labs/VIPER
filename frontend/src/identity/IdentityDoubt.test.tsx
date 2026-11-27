import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, expect, it, vi } from 'vitest'

import { IdentityNotice } from './IdentityDoubt'

afterEach(() => {
  vi.unstubAllGlobals()
})

const DOUBT = { address: 'samuel.durand@exemple.fr', reason: 'colleague_name', other_name: 'Samuel Durand', other_id: null } as const

function show() {
  render(
    <QueryClientProvider client={new QueryClient()}>
      <IdentityNotice prospectId="p1" doubts={[DOUBT]} />
    </QueryClientProvider>,
  )
}

it('says why and records the person’s confirmation', async () => {
  const fetch = vi.fn().mockResolvedValue(new Response(null, { status: 204 }))
  vi.stubGlobal('fetch', fetch)
  show()
  expect(screen.getByText(/au nom de Samuel Durand/i, { selector: '.identity-notice__text' })).toBeInTheDocument()
  await userEvent.click(screen.getByRole('button', { name: 'C’est bien son adresse' }))
  await waitFor(() => { expect(fetch).toHaveBeenCalled() })
  expect(String(fetch.mock.calls[0]?.[0])).toContain('/prospects/p1/email-identity')
})

it('says when the confirmation was not recorded', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{}', { status: 500 })))
  show()
  await userEvent.click(screen.getByRole('button', { name: 'C’est bien son adresse' }))
  expect(await screen.findByRole('alert')).toHaveTextContent('n’a pas été enregistrée')
})
