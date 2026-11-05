import { screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import { useState } from 'react'
import { vi } from 'vitest'
import { renderApp } from '../test/render'
import { stubProspectionApi } from '../test/prospectionApi'
import { ServiceInterestEditor } from './ServiceInterestEditor'

// Persistence contract is exercised end-to-end against PostgreSQL in Playwright.
describe('Company service interests', () => {
  it('edits multiple services through explicit controls and reloads them on reopen', async () => {
    const api = stubProspectionApi()
    let selected: string[] = []
    const underlying = api.fetchMock
    vi.stubGlobal(
      'fetch',
      vi.fn((input: string, init?: RequestInit) => {
        if (!input.includes('/companies/company/services')) return underlying(input, init)
        if (init?.method === 'PUT') {
          const code = input.split('/').at(-1) ?? ''
          const body = JSON.parse(init.body as string) as { identified: boolean }
          selected = body.identified ? [...selected, code] : selected.filter((item) => item !== code)
        }
        return Promise.resolve(
          new Response(JSON.stringify({ company_id: 'company', services: selected }), { status: 200 }),
        )
      }),
    )
    function Wrapper() {
      const [open, setOpen] = useState(true)
      return (
        <>
          {open ? (
            <ServiceInterestEditor
              id="company"
              name="Entreprise Exemple"
              onClose={() => {
                setOpen(false)
              }}
            />
          ) : (
            <button
              onClick={() => {
                setOpen(true)
              }}
            >
              Rouvrir
            </button>
          )}
        </>
      )
    }
    renderApp('/prospection', {
      wrap: (app) => (
        <>
          {app}
          <Wrapper />
        </>
      ),
    })
    const dialog = await screen.findByRole('dialog')
    const iguard = await within(dialog).findByRole('button', { name: /IGUARD/ })
    await userEvent.click(iguard)
    expect(await within(dialog).findByRole('button', { name: /IGUARD/, pressed: true })).toBeInTheDocument()
    await userEvent.click(within(dialog).getByRole('button', { name: /IADVICE/ }))
    expect(await within(dialog).findByRole('button', { name: /IADVICE/, pressed: true })).toBeInTheDocument()
    await userEvent.click(within(dialog).getByRole('button', { name: 'Terminer' }))
    await userEvent.click(screen.getByRole('button', { name: 'Rouvrir' }))
    expect(await screen.findByRole('button', { name: /IGUARD/, pressed: true })).toBeInTheDocument()
    expect(await screen.findByRole('button', { name: /IADVICE/, pressed: true })).toBeInTheDocument()
    expect(selected).toEqual(['iguard', 'iadvice'])
  })
})
