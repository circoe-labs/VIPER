import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { type ReactNode, useState } from 'react'
import { describe, expect, it } from 'vitest'

import { setCsrfToken } from '../api/client'
import { referent, stubSettingsApi, taxonomyValue } from '../test/settingsApi'
import { ReferentSelect, splitFullName, TaxonomyMultiSelect, TaxonomySelect } from './selectors'

function renderWithQueries(ui: ReactNode) {
  setCsrfToken('csrf-token-de-test')
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(<QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>)
}

function RolePicker({ initial = null }: { initial?: string | null }) {
  const [value, setValue] = useState<string | null>(initial)
  return (
    <>
      <TaxonomySelect kind="roles" label="Rôle" value={value} onChange={setValue} />
      <output aria-label="Valeur">{value ?? ''}</output>
    </>
  )
}

const value = () => screen.getByRole('status', { name: 'Valeur' })

describe('Settings pickers', () => {
  it('lists the active values and keeps a selected inactive one', async () => {
    const retired = taxonomyValue('Ancien rôle', { active: false })
    stubSettingsApi({ roles: [taxonomyValue('Dirigeant'), retired, taxonomyValue('Autre ancien', { active: false })] })
    renderWithQueries(<RolePicker initial={retired.id} />)

    const input = screen.getByRole('combobox', { name: 'Rôle' })
    await waitFor(() => {
      expect(input).toHaveValue('Ancien rôle')
    })
    await userEvent.click(input)

    expect(screen.getAllByRole('option').map((option) => option.textContent)).toEqual(['Dirigeant', 'Ancien rôleInactif'])
  })

  it('creates a role inline through the audited API and selects it', async () => {
    const api = stubSettingsApi({ roles: [taxonomyValue('Dirigeant')] })
    renderWithQueries(<RolePicker />)
    const input = screen.getByRole('combobox', { name: 'Rôle' })

    await userEvent.type(input, 'Responsable qualité')
    await userEvent.click(await screen.findByRole('option', { name: 'Créer « Responsable qualité »' }))

    await waitFor(() => {
      expect(input).toHaveValue('Responsable qualité')
    })
    const created = api.store.roles.find((role) => role.label === 'Responsable qualité')
    expect(value()).toHaveTextContent(created?.id ?? 'missing')
    expect(api.requests).toContainEqual(
      expect.objectContaining({ method: 'POST', path: '/api/settings/roles', body: { label: 'Responsable qualité' } }),
    )
  })

  it('reports a refused inline creation under the field', async () => {
    // The list was loaded before someone else created the value.
    const api = stubSettingsApi({ roles: [] })
    renderWithQueries(<RolePicker />)
    const input = screen.getByRole('combobox', { name: 'Rôle' })
    await userEvent.click(input)
    api.store.roles.push(taxonomyValue('Acheteur'))

    await userEvent.type(input, 'ACHETEUR')
    await userEvent.click(await screen.findByRole('option', { name: 'Créer « ACHETEUR »' }))

    expect(await screen.findByText('« Acheteur » existe déjà.')).toBeInTheDocument()
    expect(value()).toHaveTextContent('')
  })

  it('picks several activity categories', async () => {
    stubSettingsApi({ 'activity-categories': [taxonomyValue('Entreposage'), taxonomyValue('Messagerie')] })
    function Categories() {
      const [ids, setIds] = useState<string[]>([])
      return <TaxonomyMultiSelect kind="activity-categories" label="Catégories" value={ids} onChange={setIds} />
    }
    renderWithQueries(<Categories />)

    await userEvent.click(screen.getByRole('combobox', { name: 'Catégories' }))
    await userEvent.click(await screen.findByRole('option', { name: 'Entreposage' }))
    await userEvent.click(screen.getByRole('option', { name: 'Messagerie' }))

    expect(screen.getByRole('button', { name: 'Retirer « Entreposage »' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Retirer « Messagerie »' })).toBeInTheDocument()
  })

  it('creates a referent from "Prénom Nom" and asks for both names', async () => {
    const api = stubSettingsApi({ referents: [referent('Camille', 'Exemple', { email: 'camille@example.com' })] })
    function Referent() {
      const [id, setId] = useState<string | null>(null)
      return <ReferentSelect label="Référent" value={id} onChange={setId} />
    }
    renderWithQueries(<Referent />)
    const input = screen.getByRole('combobox', { name: 'Référent' })

    await userEvent.click(input)
    expect(await screen.findByRole('option', { name: 'Camille Exemplecamille@example.com' })).toBeInTheDocument()
    await userEvent.type(input, 'Marie')
    expect(screen.getByText('Saisissez le prénom puis le nom pour créer un référent.')).toBeInTheDocument()
    await userEvent.type(input, ' De La Test{Enter}')

    await waitFor(() => {
      expect(input).toHaveValue('Marie De La Test')
    })
    expect(api.requests).toContainEqual(
      expect.objectContaining({
        method: 'POST',
        path: '/api/settings/referents',
        body: { first_name: 'Marie', last_name: 'De La Test', email: null },
      }),
    )
  })

  it('splits a full name on its first space', () => {
    expect(splitFullName('  Jean-Marc   De La Test ')).toEqual({ first_name: 'Jean-Marc', last_name: 'De La Test' })
    expect(splitFullName('Marie')).toBeNull()
  })
})
