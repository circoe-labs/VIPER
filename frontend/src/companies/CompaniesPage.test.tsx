import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'

import { company, establishment, stubCompaniesApi } from '../test/companiesApi'
import { renderApp } from '../test/render'
import { taxonomyValue } from '../test/settingsApi'

function table() {
  return screen.getByRole('table', { name: 'Liste des entreprises' })
}

describe('Companies (Prospection entity=company)', () => {
  it('filters company types and reloads the category after editing the existing company file', async () => {
    stubCompaniesApi({ companies: [
      company('Petit atelier', { company_kind: 'sme' }),
      company('Grand groupe', { company_kind: 'large' }),
      company('Mairie exemple', { company_kind: 'institutional' }),
      company('Sans classement'),
    ] })
    renderApp('/prospection?entity=company')
    await screen.findByRole('button', { name: 'Petit atelier' })
    // The company types are the quick filters of the « Filtres » menu (opened on demand).
    const categories = async () => {
      if (!screen.queryByRole('group', { name: 'Filtres rapides' })) await userEvent.click(screen.getByText('Filtres', { selector: 'summary' }))
      return within(screen.getByRole('group', { name: 'Filtres rapides' }))
    }
    const kinds: [string, string][] = [
      ['Institutionnelles', 'Mairie exemple'],
      ['PME', 'Petit atelier'],
      ['Grosses entreprises', 'Grand groupe'],
      ['À classer', 'Sans classement'],
    ]
    for (const [label, name] of kinds) {
      await userEvent.click((await categories()).getByRole('button', { name: new RegExp(`^${label}`) }))
      await waitFor(() => {
        expect(within(table()).getAllByRole('row')).toHaveLength(2)
        expect(within(table()).getByRole('button', { name })).toBeInTheDocument()
      })
    }
    await userEvent.click(within(table()).getByRole('button', { name: 'Sans classement' }))
    const drawer = await screen.findByRole('dialog', { name: 'Sans classement' })
    await userEvent.selectOptions(within(drawer).getByRole('combobox', { name: 'Type d’entreprise' }), 'sme')
    await userEvent.click(within(drawer).getByRole('button', { name: 'Enregistrer' }))
    expect(await screen.findByText('Aucune entreprise ne correspond à ces critères.')).toBeInTheDocument()
    await userEvent.keyboard('{Escape}')
    await userEvent.click((await categories()).getByRole('button', { name: /^PME/ }))
    expect(await within(await screen.findByRole('table', { name: 'Liste des entreprises' })).findByRole('button', { name: 'Sans classement' })).toBeInTheDocument()
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
    renderApp('/prospection?entity=company')

    const row = await screen.findByRole('row', { name: /Transports Exemple/ })
    expect(within(row).getAllByRole('cell').map((cell) => cell.textContent)).toEqual([
      'TETransports ExempleTransports Exemple SAS',
      'À classer',
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
    renderApp('/prospection?entity=company')
    await screen.findByRole('button', { name: 'Logistique Témoin' })

    await userEvent.type(screen.getByRole('searchbox'), 'TEMOIN')
    await waitFor(() => {
      expect(within(table()).queryByRole('button', { name: 'Transports Exemple' })).not.toBeInTheDocument()
    })
    expect(api.requests.at(-1)?.search).toContain('q=TEMOIN')

    await userEvent.clear(screen.getByRole('searchbox'))
    await userEvent.type(screen.getByRole('searchbox'), 'introuvable')
    expect(await screen.findByText('Aucune entreprise ne correspond à ces critères.')).toBeInTheDocument()
  })

  it('pages through long lists', async () => {
    const api = stubCompaniesApi({
      companies: Array.from({ length: 55 }, (_, index) => company(`Entreprise ${String(index + 1).padStart(2, '0')}`)),
    })
    renderApp('/prospection?entity=company')
    const pager = await screen.findByRole('navigation', { name: 'Pages des entreprises' })
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
    renderApp('/prospection?entity=company')

    expect(await screen.findByRole('heading', { level: 2, name: 'Aucune entreprise pour l’instant' })).toBeInTheDocument()
    const buttons = screen.getAllByRole('button', { name: 'Nouvelle entreprise' })
    await userEvent.click(buttons.at(-1) as HTMLElement)

    expect(screen.getByRole('dialog', { name: 'Nouvelle entreprise' })).toBeInTheDocument()
  })

  it('refreshes the list after a save in the editor', async () => {
    stubCompaniesApi({ companies: [company('Transports Exemple')] })
    renderApp('/prospection?entity=company')
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

  it('never shows a search answer read before a save, even when it arrives after it', async () => {
    const api = stubCompaniesApi({ companies: [company('Transports Exemple')] })
    // A slow server: the first search request reads the companies at once but answers only when released.
    const held: (() => void)[] = []
    vi.stubGlobal('fetch', (input: string, init?: RequestInit) => {
      const answer = api.fetchMock(input, init)
      if (held.length > 0 || !new URL(input, 'http://localhost').searchParams.has('q')) return answer
      return new Promise<Response>((resolve) => {
        held.push(() => {
          void answer.then(resolve)
        })
      })
    })
    renderApp('/prospection?entity=company')
    await screen.findByRole('button', { name: 'Transports Exemple' })
    await userEvent.type(screen.getByRole('searchbox'), 'Exemple')
    await waitFor(() => {
      expect(held).toHaveLength(1)
    })

    // The previous list stays on screen while the search loads: open the company from it and rename it.
    await userEvent.click(within(table()).getByRole('button', { name: 'Transports Exemple' }))
    const name = await screen.findByRole('textbox', { name: /Nom de l’entreprise/ })
    await waitFor(() => {
      expect(name).toHaveValue('Transports Exemple')
    })
    await userEvent.type(name, ' Nord{Enter}')
    await screen.findByText('Entreprise enregistrée.')
    held[0]?.()

    await waitFor(() => {
      expect(within(table()).getByRole('button', { name: 'Transports Exemple Nord' })).toBeInTheDocument()
    })
    expect(within(table()).queryByRole('button', { name: 'Transports Exemple' })).not.toBeInTheDocument()
  })
})
