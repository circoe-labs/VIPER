import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'

import type { Warehouse } from '../api/warehouses'
import { SHELL_API } from '../test/homeApi'
import { renderApp, stubApi } from '../test/render'

const SITE: Warehouse = {
  id: 'site-1',
  version: 'v1',
  source_reference: null,
  status: 'incomplete',
  missing: ['company'],
  company_id: null,
  company_name: null,
  building_name: null,
  name: 'Transports Exemple',
  prospecting_category: 'other',
  owner_name: null,
  owner_role: null,
  owner_email: null,
  owner_linkedin: null,
  address: null,
  postal_code: null,
  city: null,
  siret: null,
  notes: null,
  contacts: [{ full_name: 'Anne MARTIN', role: null, email: null, linkedin: null }],
}

describe('Vérification — Entrepôts', () => {
  it('shows the warehouse contacts as their own valid slice of the base', async () => {
    stubApi({
      ...SHELL_API,
      'GET /api/warehouses/counts': [200, { warehouses: 50, contacts: 122, to_contact: 0, sme: 0, other: 0, unclassified: 50 }],
    })
    renderApp('/prospection/verification')

    const box = await screen.findByRole('button', { name: /Entrepôts/ })
    await waitFor(() => { expect(box).toHaveTextContent('122') })
    expect(screen.getByRole('img', { name: /Répartition de la base/ })).toBeInTheDocument()
    expect(screen.getByText((_, element) => element?.tagName === 'LI' && /^Entrepôts 122/.test(element.textContent))).toBeInTheDocument()
  })

  it('adds a warehouse prospect with the chosen category, then clears for the next one', async () => {
    const fetchMock = stubApi({
      ...SHELL_API,
      'GET /api/warehouses/counts': [200, { warehouses: 0, contacts: 0, to_contact: 0, sme: 0, other: 0, unclassified: 0 }],
      'POST /api/warehouses': [201, SITE],
    })
    const user = userEvent.setup()
    renderApp('/prospection/verification')
    await user.click(await screen.findByRole('button', { name: /Entrepôts/ }))

    await user.type(await screen.findByLabelText(/Entreprise/), 'Transports Exemple')
    await user.type(screen.getByLabelText(/Prénom/), 'Anne')
    await user.type(screen.getByLabelText(/^Nom/), 'Martin')
    await user.type(screen.getByLabelText('Fonction'), 'Responsable logistique')
    await user.type(screen.getByLabelText('E-mail'), 'anne@example.test')
    await user.type(screen.getByLabelText('LinkedIn'), 'https://www.linkedin.com/in/anne')

    await user.click(screen.getByRole('button', { name: 'Validé, suivant' }))
    expect(screen.getByRole('alert')).toHaveTextContent('Choisissez « PME / TPE »')

    await user.click(screen.getByRole('button', { name: 'Autre entreprise' }))
    await user.click(screen.getByRole('button', { name: 'Validé, suivant' }))

    const [, init] = fetchMock.mock.calls.find(([url, request]) => url.endsWith('/api/warehouses') && request?.method === 'POST') ?? []
    expect(JSON.parse(init?.body as string)).toMatchObject({
      name: 'Transports Exemple',
      prospecting_category: 'other',
      contacts: [{ full_name: 'Anne MARTIN', role: 'Responsable logistique', email: 'anne@example.test', to_contact: true }],
    })
    expect(await screen.findByText(/Anne MARTIN \(Transports Exemple\) est enregistré/)).toBeInTheDocument()
    expect(screen.getByLabelText(/Entreprise/)).toHaveValue('')
  })
})
