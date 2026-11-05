import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import { SHELL_API } from '../test/homeApi'
import { renderApp, stubApi } from '../test/render'
import type { Warehouse } from '../api/warehouses'

const ROW: Warehouse = { id: '00000000-0000-7000-a000-000000000001', version: '2026-11-03T10:00:00+00:00', name: 'Entrepôt Exemple', owner_name: 'Propriétaire Test', owner_role: 'Foncière', owner_email: null, owner_linkedin: null, address: null, city: 'Lyon', postal_code: null, siret: null, notes: null, source_reference: 'synthetic.xlsx · Sites', contacts: [{ full_name: 'Anne Test', role: 'Responsable', email: 'anne@exemple.test ou a.test@exemple.test', linkedin: 'https://www.linkedin.com/in/test-anne' }] }

describe('Warehouse directory', () => {
  it('places directors first, then logistics managers, and keeps the other contacts in their original order', async () => {
    const contact = (full_name: string, role: string | null) => ({ full_name, role, email: null, linkedin: null })
    const warehouse = { ...ROW, contacts: [
      contact('Autre personne', 'Commercial'),
      contact('Responsable logistique', 'Responsable logistique'),
      contact('Personne sans fonction', null),
      contact('Directrice', 'Directrice du site'),
      contact('Gérant', 'Gérant logistique'),
      contact('Directeur', 'Directeur logistique'),
    ] }
    stubApi({ ...SHELL_API, 'GET /api/warehouses': [200, { items: [warehouse], total: 1 }] })
    renderApp('/warehouses')
    await userEvent.click(await screen.findByRole('button', { name: 'Détails de Entrepôt Exemple' }))
    const list = screen.getByRole('list', { name: 'Interlocuteurs de Entrepôt Exemple' })
    expect(within(list).getAllByRole('listitem').map((item) => item.querySelector('strong')?.textContent)).toEqual([
      'Directrice', 'Directeur', 'Responsable logistique', 'Gérant', 'Autre personne', 'Personne sans fonction',
    ])
  })

  it('has its own navigation, compact closed sites and real source contacts on demand', async () => {
    stubApi({ ...SHELL_API, 'GET /api/warehouses': [200, { items: [ROW], total: 1 }] })
    renderApp('/warehouses')
    expect(screen.getByRole('heading', { level: 1, name: 'Entrepôts' })).toBeVisible()
    expect(within(screen.getByRole('navigation', { name: 'Navigation principale' })).getByRole('link', { name: 'Entrepôts' })).toHaveAttribute('aria-current', 'page')
    const open = await screen.findByRole('button', { name: 'Détails de Entrepôt Exemple' })
    expect(open).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByText('Anne Test')).not.toBeVisible()
    await userEvent.click(open)
    expect(screen.getByText('Anne Test')).toBeVisible()
    expect(screen.getByText('anne@exemple.test ou a.test@exemple.test')).toBeVisible()
    expect(screen.getByText('Propriétaire Test')).toBeVisible()
    expect(screen.getByRole('link', { name: 'Profil LinkedIn' })).toHaveAttribute('href', ROW.contacts[0]?.linkedin)
    await userEvent.click(open)
    expect(screen.getByText('Anne Test')).not.toBeVisible()
  })

  it('shows an honest empty state and creates a site with its interlocutors', async () => {
    let saved: unknown
    stubApi({ ...SHELL_API, 'GET /api/warehouses': [200, { items: [], total: 0 }],
      'POST /api/warehouses': () => [201, ROW] })
    const { queryClient } = renderApp('/warehouses')
    expect(await screen.findByText('Votre répertoire d’entrepôts')).toBeVisible()
    await userEvent.click(screen.getByRole('button', { name: 'Ajouter le premier entrepôt' }))
    const form = within(screen.getByRole('dialog', { name: 'Ajouter un entrepôt' }))
    await userEvent.type(form.getByRole('textbox', { name: 'Nom de l’entrepôt' }), 'Site Exemple')
    await userEvent.click(form.getByRole('button', { name: 'Ajouter un interlocuteur' }))
    await userEvent.type(form.getByRole('textbox', { name: 'Nom et prénom' }), 'Anne Test')
    await userEvent.type(form.getByRole('textbox', { name: 'E-mail(s) à confirmer' }), 'anne@exemple.test ou a.test@exemple.test')
    const unsubscribe = queryClient.getMutationCache().subscribe((event) => {
      if (event.mutation?.state.status === 'success') saved = event.mutation.state.variables
    })
    await userEvent.click(form.getByRole('button', { name: 'Enregistrer' }))
    await waitFor(() => { expect(screen.queryByRole('dialog')).not.toBeInTheDocument() })
    unsubscribe()
    expect(saved).toMatchObject({ id: null, data: { name: 'Site Exemple', contacts: [{ full_name: 'Anne Test', email: 'anne@exemple.test ou a.test@exemple.test' }] } })
  })

  it('preserves the read version and contacts when editing an existing site', async () => {
    stubApi({ ...SHELL_API, 'GET /api/warehouses': [200, { items: [ROW], total: 1 }],
      [`GET /api/warehouses/${ROW.id}`]: [200, ROW], [`PUT /api/warehouses/${ROW.id}`]: [409, { detail: { code: 'conflict' } }] })
    renderApp('/warehouses')
    await userEvent.click(await screen.findByRole('button', { name: 'Modifier Entrepôt Exemple' }))
    const dialog = within(screen.getByRole('dialog', { name: 'Modifier l’entrepôt' }))
    expect(await dialog.findByRole('textbox', { name: 'Nom de l’entrepôt' })).toHaveValue(ROW.name)
    expect(dialog.getByRole('textbox', { name: 'E-mail(s) à confirmer' })).toHaveValue(ROW.contacts[0]?.email)
    await userEvent.click(dialog.getByRole('button', { name: 'Enregistrer' }))
    expect(await dialog.findByRole('alert')).toHaveTextContent('Cette fiche a changé.')
    expect(dialog.getByRole('textbox', { name: 'Nom de l’entrepôt' })).toHaveValue(ROW.name)
  })

  it('reports a list failure rather than showing a false empty directory', async () => {
    stubApi({ ...SHELL_API, 'GET /api/warehouses': [500, {}] })
    renderApp('/warehouses')
    expect(await screen.findByRole('alert')).toHaveTextContent('Impossible de charger les entrepôts.')
    expect(screen.queryByText('Votre répertoire d’entrepôts')).not.toBeInTheDocument()
  })
})
