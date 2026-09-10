import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'

import { company, establishment, stubCompaniesApi } from '../test/companiesApi'
import { renderApp } from '../test/render'
import { taxonomyValue } from '../test/settingsApi'

function table() {
  return screen.getByRole('table', { name: 'Liste des entreprises' })
}

describe('Companies page', () => {
  it('is a secondary page of Prospection, reachable from its placeholder', async () => {
    stubCompaniesApi({ companies: [company('Transports Exemple')] })
    renderApp('/prospection')

    await userEvent.click(screen.getByRole('link', { name: 'Gérer les entreprises' }))

    expect(screen.getByRole('heading', { level: 1, name: 'Entreprises' })).toBeInTheDocument()
    const navigation = screen.getByRole('navigation', { name: 'Navigation principale' })
    expect(within(navigation).getByRole('link', { name: 'Prospection' })).toHaveAttribute('aria-current', 'page')
  })

  it('lists the companies with their identifiers, primary city, segment and counts', async () => {
    const segment = taxonomyValue('Transporteur')
    stubCompaniesApi({
      segments: [segment],
      companies: [
        company('Transports Exemple', {
          legal_name: 'Transports Exemple SAS',
          siren: '999000011',
          email_domain: 'exemple.fr',
          commercial_segment: { id: segment.id, label: 'Transporteur', active: true },
          prospect_count: 3,
          establishments: [
            establishment('Dépôt', { city: 'Lille' }),
            establishment('Siège', { city: 'Lyon', is_primary: true }),
          ],
        }),
      ],
    })
    renderApp('/prospection/companies')

    const row = await screen.findByRole('row', { name: /Transports Exemple/ })
    expect(within(row).getAllByRole('cell').map((cell) => cell.textContent)).toEqual([
      'Transports ExempleTransports Exemple SAS',
      '999 000 011',
      'exemple.fr',
      'Lyon',
      'Transporteur',
      '2',
      '3',
    ])
    expect(screen.getByText('1 entreprise')).toBeInTheDocument()
  })

  it('searches through the API and says when nothing matches', async () => {
    const api = stubCompaniesApi({ companies: [company('Transports Exemple'), company('Logistique Témoin')] })
    renderApp('/prospection/companies')
    await screen.findByRole('button', { name: 'Logistique Témoin' })

    await userEvent.type(screen.getByRole('searchbox'), 'TEMOIN')
    await waitFor(() => {
      expect(within(table()).queryByRole('button', { name: 'Transports Exemple' })).not.toBeInTheDocument()
    })
    expect(api.requests.at(-1)?.search).toContain('q=TEMOIN')

    await userEvent.clear(screen.getByRole('searchbox'))
    await userEvent.type(screen.getByRole('searchbox'), 'introuvable')
    expect(await screen.findByText('Aucune entreprise ne correspond à « introuvable ».')).toBeInTheDocument()
  })

  it('pages through long lists', async () => {
    const api = stubCompaniesApi({
      companies: Array.from({ length: 55 }, (_, index) => company(`Entreprise ${String(index + 1).padStart(2, '0')}`)),
    })
    renderApp('/prospection/companies')
    const pager = await screen.findByRole('navigation', { name: 'Pages de la liste' })
    expect(pager).toHaveTextContent('1–50 sur 55')
    expect(within(pager).getByRole('button', { name: 'Précédentes' })).toBeDisabled()

    await userEvent.click(within(pager).getByRole('button', { name: 'Suivantes' }))

    await waitFor(() => {
      expect(pager).toHaveTextContent('51–55 sur 55')
    })
    expect(api.requests.at(-1)?.search).toContain('offset=50')
    expect(within(pager).getByRole('button', { name: 'Suivantes' })).toBeDisabled()
  })

  it('shows an empty state that creates the first company', async () => {
    stubCompaniesApi()
    renderApp('/prospection/companies')

    expect(await screen.findByRole('heading', { level: 2, name: 'Aucune entreprise pour l’instant' })).toBeInTheDocument()
    const buttons = screen.getAllByRole('button', { name: 'Nouvelle entreprise' })
    await userEvent.click(buttons.at(-1) as HTMLElement)

    expect(screen.getByRole('dialog', { name: 'Nouvelle entreprise' })).toBeInTheDocument()
  })

  it('refreshes the list after a save in the editor', async () => {
    stubCompaniesApi({ companies: [company('Transports Exemple')] })
    renderApp('/prospection/companies')
    await userEvent.click(await screen.findByRole('button', { name: 'Transports Exemple' }))
    const name = await screen.findByRole('textbox', { name: /Nom de l’entreprise/ })
    await waitFor(() => {
      expect(name).toHaveValue('Transports Exemple')
    })

    await userEvent.type(name, ' Nord{Enter}')

    await waitFor(() => {
      expect(within(table()).getByRole('button', { name: 'Transports Exemple Nord' })).toBeInTheDocument()
    })
  })
})
