import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'

import type { ProspectCreateInput } from '../api/prospects'
import { company } from '../test/companiesApi'
import { lastBody, stubProspectsApi } from '../test/prospectsApi'
import { renderProspectEditor } from '../test/renderProspectEditor'

const employer = company('Transports Exemple SARL')

async function pickCompany(text: string, option: RegExp) {
  const picker = screen.getByRole('combobox', { name: /Entreprise/ })
  await userEvent.type(picker, text)
  await userEvent.click(await screen.findByRole('option', { name: option }))
}

describe('Prospect editor — new prospect', () => {
  it('creates a person with the company and the manual provenance, then offers the next one', async () => {
    const api = stubProspectsApi({ companies: [employer] })
    renderProspectEditor('new')
    expect(screen.getByRole('dialog', { name: 'Nouveau prospect' })).toBeInTheDocument()
    expect(screen.getByRole('textbox', { name: 'Prénom' })).toHaveFocus()

    await userEvent.type(screen.getByRole('textbox', { name: 'Prénom' }), 'Nina')
    await userEvent.type(screen.getByRole('textbox', { name: 'Nom' }), 'Nouvelle')
    await pickCompany('Transports', /Transports Exemple SARL/)
    await userEvent.type(screen.getByRole('textbox', { name: 'Adresse e-mail' }), 'nina@exemple.example')
    await userEvent.click(screen.getByRole('button', { name: 'Enregistrer et nouveau' }))

    expect(await screen.findByText(/Prospect enregistré\. Saisissez le suivant/)).toBeInTheDocument()
    const body = lastBody(api.requests, 'POST') as ProspectCreateInput
    expect(body).toMatchObject({
      first_name: 'Nina',
      last_name: 'Nouvelle',
      company_id: employer.id,
      activity_status: 'unknown',
      phones: [],
      provenance: { legal_basis_or_collection_context: 'Saisie manuelle — prospection B2B', source_reference: null },
    })
    expect(body.emails).toEqual([expect.objectContaining({ address: 'nina@exemple.example', is_primary: true, verified_now: false })])
    expect(screen.getByRole('textbox', { name: 'Prénom' })).toHaveValue('')
    await waitFor(() => {
      expect(screen.getByRole('combobox', { name: /Entreprise/ })).toHaveValue('Transports Exemple SARL')
    })
  })

  it('requires a name and a company before sending anything', async () => {
    const api = stubProspectsApi()
    renderProspectEditor('new')

    await userEvent.type(screen.getByRole('textbox', { name: 'Adresse e-mail' }), 'x@exemple.example')
    await userEvent.keyboard('{Control>}s{/Control}')

    expect(screen.getByRole('textbox', { name: 'Nom' })).toHaveAccessibleDescription('Saisissez au moins un prénom ou un nom.')
    expect(screen.getByText('Corrigez les 2 champs signalés.')).toBeInTheDocument()
    expect(api.requests).toEqual([])
  })

  it('creates a missing company through the Company editor, prefilled with the typed name', async () => {
    const api = stubProspectsApi()
    renderProspectEditor('new')

    await pickCompany('Logistique Inventée', /Créer l’entreprise « Logistique Inventée »/)
    const companyEditor = await screen.findByRole('dialog', { name: 'Nouvelle entreprise' })
    expect(within(companyEditor).getByRole('textbox', { name: /Nom de l’entreprise/ })).toHaveValue('Logistique Inventée')
    await userEvent.click(within(companyEditor).getByRole('button', { name: 'Enregistrer' }))
    await within(companyEditor).findByText('Entreprise enregistrée.')
    await userEvent.keyboard('{Escape}')

    expect(screen.queryByRole('dialog', { name: 'Logistique Inventée' })).not.toBeInTheDocument()
    expect(screen.getByRole('combobox', { name: /Entreprise/ })).toHaveValue('Logistique Inventée')
    expect(api.companies.map((row) => row.display_name)).toEqual(['Logistique Inventée'])
  })
})
