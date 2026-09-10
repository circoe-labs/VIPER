import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'

import { referent, stubSettingsApi, taxonomyValue } from '../test/settingsApi'
import { renderApp } from '../test/render'

function seededApi() {
  return stubSettingsApi({
    roles: [
      taxonomyValue('Dirigeant', { usage_count: 3 }),
      taxonomyValue('Responsable transport'),
      taxonomyValue('Ancien rôle', { active: false }),
    ],
    'activity-categories': [taxonomyValue('Entreposage')],
    referents: [
      referent('Camille', 'Exemple', { email: 'camille.exemple@example.com', usage_count: 2 }),
      referent('Alex', 'Test'),
    ],
  })
}

const rolesTable = () => screen.findByRole('table', { name: 'Liste des rôles' })
// The panel's status region (the shell has its own for the API status).
const feedback = (section = 'Rôles') => within(screen.getByRole('region', { name: section })).getByRole('status')
const row = (name: string) => screen.getByRole('row', { name: new RegExp(name) })

describe('SettingsPage', () => {
  it('shows the four sections, the roles by default, with usage and status', async () => {
    seededApi()
    renderApp('/settings')

    expect(screen.getByRole('heading', { level: 1, name: 'Paramètres' })).toBeInTheDocument()
    const sections = screen.getByRole('navigation', { name: 'Sections des paramètres' })
    expect(within(sections).getAllByRole('link').map((link) => link.firstChild?.textContent)).toEqual([
      'Rôles',
      'Catégories d’activité',
      'Segments commerciaux',
      'Référents internes',
    ])
    expect(screen.getByRole('heading', { level: 2, name: 'Rôles' })).toBeInTheDocument()

    const table = await rolesTable()
    const rows = within(table).getAllByRole('row').slice(1)
    expect(rows.map((line) => within(line).getAllByRole('cell').slice(0, 3).map((cell) => cell.textContent))).toEqual([
      ['Dirigeant', '3 prospects', 'Actif'],
      ['Responsable transport', 'Non utilisé', 'Actif'],
      ['Ancien rôle', 'Non utilisé', 'Inactif'],
    ])
    expect(await within(sections).findByText('3')).toBeInTheDocument()
  })

  it('opens another section from the sub-navigation', async () => {
    seededApi()
    renderApp('/settings')

    await userEvent.click(screen.getByRole('link', { name: /Catégories d’activité/ }))

    expect(screen.getByRole('heading', { level: 2, name: 'Catégories d’activité' })).toBeInTheDocument()
    expect(await screen.findByRole('cell', { name: 'Entreposage' })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: /Catégories d’activité/ })).toHaveAttribute('aria-current', 'page')
  })

  it('adds a value through the API and lists it', async () => {
    const api = seededApi()
    renderApp('/settings/roles')
    await rolesTable()

    await userEvent.type(screen.getByRole('textbox', { name: 'Nouveau rôle' }), '  Responsable qualité ')
    await userEvent.click(screen.getByRole('button', { name: 'Ajouter' }))

    expect(await screen.findByRole('cell', { name: 'Responsable qualité' })).toBeInTheDocument()
    expect(feedback()).toHaveTextContent('« Responsable qualité » ajouté.')
    expect(screen.getByRole('textbox', { name: 'Nouveau rôle' })).toHaveValue('')
    expect(api.requests).toContainEqual(
      expect.objectContaining({ method: 'POST', path: '/api/settings/roles', body: { label: '  Responsable qualité ' } }),
    )
  })

  it('explains a duplicate and offers to reactivate an inactive twin', async () => {
    const api = seededApi()
    renderApp('/settings/roles')
    await rolesTable()
    const field = screen.getByRole('textbox', { name: 'Nouveau rôle' })

    await userEvent.type(field, 'DIRIGEANT{Enter}')
    expect(await screen.findByText('« Dirigeant » existe déjà.')).toBeInTheDocument()
    expect(field).toHaveAttribute('aria-invalid', 'true')

    await userEvent.clear(field)
    await userEvent.type(field, 'ancien role{Enter}')
    expect(await screen.findByText(/« Ancien rôle » existe déjà mais est désactivé/)).toBeInTheDocument()
    const addForm = screen.getByRole('form', { name: 'Nouveau rôle' })
    await userEvent.click(within(addForm).getByRole('button', { name: 'Réactiver « Ancien rôle »' }))

    await waitFor(() => {
      expect(within(row('Ancien rôle')).getByText('Actif')).toBeInTheDocument()
    })
    expect(api.store.roles.find((value) => value.label === 'Ancien rôle')?.active).toBe(true)
  })

  it('renames a value inline: Enter saves, Escape cancels, focus returns to the row', async () => {
    const api = seededApi()
    renderApp('/settings/roles')
    await rolesTable()

    await userEvent.click(screen.getByRole('button', { name: 'Renommer « Responsable transport »' }))
    const field = screen.getByRole('textbox', { name: 'Nouveau libellé pour « Responsable transport »' })
    expect(field).toHaveFocus()
    await userEvent.keyboard('{Escape}')
    expect(screen.queryByRole('textbox', { name: /Nouveau libellé/ })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Renommer « Responsable transport »' })).toHaveFocus()

    await userEvent.keyboard('{Enter}')
    await userEvent.clear(screen.getByRole('textbox', { name: /Nouveau libellé/ }))
    await userEvent.keyboard('Responsable du transport{Enter}')

    expect(await screen.findByRole('cell', { name: 'Responsable du transport' })).toBeInTheDocument()
    expect(feedback()).toHaveTextContent(
      '« Responsable transport » renommé en « Responsable du transport ».',
    )
    const renamed = api.store.roles.find((value) => value.label === 'Responsable du transport')
    expect(api.requests).toContainEqual(
      expect.objectContaining({ method: 'PATCH', path: `/api/settings/roles/${renamed?.id ?? ''}` }),
    )
    expect(screen.getByRole('button', { name: 'Renommer « Responsable du transport »' })).toHaveFocus()
  })

  it('refuses a rename onto another value', async () => {
    seededApi()
    renderApp('/settings/roles')
    await rolesTable()

    await userEvent.click(screen.getByRole('button', { name: 'Renommer « Responsable transport »' }))
    await userEvent.clear(screen.getByRole('textbox', { name: /Nouveau libellé/ }))
    await userEvent.keyboard('dirigeant{Enter}')

    expect(await screen.findByText('« Dirigeant » existe déjà.')).toBeInTheDocument()
  })

  it('deactivates and reactivates a value', async () => {
    seededApi()
    renderApp('/settings/roles')
    await rolesTable()

    await userEvent.click(screen.getByRole('button', { name: 'Désactiver « Dirigeant »' }))
    await waitFor(() => {
      expect(within(row('Dirigeant')).getByText('Inactif')).toBeInTheDocument()
    })
    expect(feedback()).toHaveTextContent('« Dirigeant » désactivé.')

    await userEvent.click(screen.getByRole('button', { name: 'Réactiver « Dirigeant »' }))
    await waitFor(() => {
      expect(within(row('Dirigeant')).getByText('Actif')).toBeInTheDocument()
    })
  })

  it('deletes an unused value after confirmation', async () => {
    const api = seededApi()
    renderApp('/settings/roles')
    await rolesTable()

    await userEvent.click(screen.getByRole('button', { name: 'Supprimer « Responsable transport »' }))
    const dialog = screen.getByRole('dialog', { name: 'Supprimer « Responsable transport » ?' })
    await userEvent.click(within(dialog).getByRole('button', { name: 'Supprimer' }))

    await waitFor(() => {
      expect(screen.queryByRole('cell', { name: 'Responsable transport' })).not.toBeInTheDocument()
    })
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(api.store.roles.map((value) => value.label)).toEqual(['Dirigeant', 'Ancien rôle'])
  })

  it('refuses to delete a value in use and offers deactivation instead', async () => {
    const api = seededApi()
    renderApp('/settings/roles')
    await rolesTable()

    await userEvent.click(screen.getByRole('button', { name: 'Supprimer « Dirigeant »' }))
    const dialog = screen.getByRole('dialog', { name: 'Suppression impossible' })
    expect(dialog).toHaveTextContent('« Dirigeant » est utilisé par 3 prospects.')
    expect(within(dialog).queryByRole('button', { name: 'Supprimer' })).not.toBeInTheDocument()
    await userEvent.click(within(dialog).getByRole('button', { name: 'Désactiver' }))

    await waitFor(() => {
      expect(within(row('Dirigeant')).getByText('Inactif')).toBeInTheDocument()
    })
    expect(api.requests.filter((request) => request.method === 'DELETE')).toEqual([])
  })

  it('searches and filters through the API', async () => {
    const api = seededApi()
    renderApp('/settings/roles')
    await rolesTable()

    await userEvent.type(screen.getByRole('searchbox', { name: 'Rechercher un rôle' }), 'TRANSPORT')
    await waitFor(() => {
      expect(screen.queryByRole('cell', { name: 'Dirigeant' })).not.toBeInTheDocument()
    })
    expect(api.requests.at(-1)).toMatchObject({ path: '/api/settings/roles', search: '?q=TRANSPORT' })

    await userEvent.clear(screen.getByRole('searchbox', { name: 'Rechercher un rôle' }))
    await userEvent.click(screen.getByRole('radio', { name: 'Inactifs' }))
    expect(await screen.findByRole('cell', { name: 'Ancien rôle' })).toBeInTheDocument()
    await waitFor(() => {
      expect(screen.queryByRole('cell', { name: 'Responsable transport' })).not.toBeInTheDocument()
    })
    expect(api.requests.at(-1)?.search).toBe('?active=false')
  })

  it('shows an honest error with a retry when the list cannot load', async () => {
    const api = seededApi()
    api.failures.add('roles')
    renderApp('/settings/roles')

    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('Liste indisponible.')
    await userEvent.click(within(alert).getByRole('button', { name: 'Réessayer' }))

    expect(await rolesTable()).toBeInTheDocument()
  })

  it('shows an empty state for a section without values', async () => {
    seededApi()
    renderApp('/settings/commercial-segments')

    expect(await screen.findByRole('heading', { name: 'Aucun segment pour l’instant' })).toBeInTheDocument()
  })

  it('manages internal referents separately from the signed-in user', async () => {
    const api = seededApi()
    renderApp('/settings/referents')

    const table = await screen.findByRole('table', { name: 'Liste des référents internes' })
    expect(within(table).getByRole('cell', { name: 'camille.exemple@example.com' })).toBeInTheDocument()
    expect(within(row('Camille Exemple')).getByText('2 suivis de contact')).toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: 'Ajouter un référent' }))
    const dialog = screen.getByRole('dialog', { name: 'Ajouter un référent' })
    expect(within(dialog).getByRole('textbox', { name: 'Prénom' })).toHaveFocus()
    await userEvent.keyboard('Hélène')
    await userEvent.type(within(dialog).getByRole('textbox', { name: 'Nom' }), 'Démo')
    await userEvent.type(within(dialog).getByRole('textbox', { name: 'Adresse e-mail' }), 'pas-une-adresse')
    await userEvent.click(within(dialog).getByRole('button', { name: 'Enregistrer' }))
    expect(within(dialog).getByText('Adresse e-mail invalide.')).toBeInTheDocument()
    expect(api.requests.some((request) => request.method === 'POST')).toBe(false)

    await userEvent.clear(within(dialog).getByRole('textbox', { name: 'Adresse e-mail' }))
    await userEvent.click(within(dialog).getByRole('button', { name: 'Enregistrer' }))

    expect(await screen.findByRole('cell', { name: 'Hélène Démo' })).toBeInTheDocument()
    expect(api.requests).toContainEqual(
      expect.objectContaining({
        method: 'POST',
        path: '/api/settings/referents',
        body: { first_name: 'Hélène', last_name: 'Démo', email: null },
      }),
    )
  })

  it('shows a duplicate referent name on the name field', async () => {
    seededApi()
    renderApp('/settings/referents')
    await screen.findByRole('table', { name: 'Liste des référents internes' })

    await userEvent.click(screen.getByRole('button', { name: 'Modifier « Alex Test »' }))
    const dialog = screen.getByRole('dialog', { name: 'Modifier « Alex Test »' })
    await userEvent.clear(within(dialog).getByRole('textbox', { name: 'Prénom' }))
    await userEvent.type(within(dialog).getByRole('textbox', { name: 'Prénom' }), 'camille')
    await userEvent.clear(within(dialog).getByRole('textbox', { name: 'Nom' }))
    await userEvent.type(within(dialog).getByRole('textbox', { name: 'Nom' }), 'EXEMPLE')
    await userEvent.click(within(dialog).getByRole('button', { name: 'Enregistrer' }))

    expect(await within(dialog).findByText('« Camille Exemple » existe déjà.')).toBeInTheDocument()
  })
})
