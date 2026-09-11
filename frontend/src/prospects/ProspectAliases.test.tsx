import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'

import type { PhoneAlias, Prospect, ProspectInput } from '../api/prospects'
import { company } from '../test/companiesApi'
import { fill } from '../test/fill'
import { companySummary, lastBody, prospectDetail, stubProspectsApi } from '../test/prospectsApi'
import { renderProspectEditor } from '../test/renderProspectEditor'

const VERIFIED = '2026-06-01T08:00:00+00:00'
const employer = company('Transports Exemple SARL', { email_domain: 'exemple.example' })
const other = company('Autre Employeur SAS', { email_domain: 'autre.example' })

function phone(id: string, number: string, fields: Partial<PhoneAlias> = {}): PhoneAlias {
  return {
    id,
    number,
    type: 'mobile',
    is_primary: false,
    is_active: true,
    verification_status: 'unverified',
    last_verified_at: null,
    origin_type: 'manual',
    source_reference: null,
    imported_unverified: false,
    ...fields,
  }
}

function person(fields: Partial<Prospect> = {}): Prospect {
  return prospectDetail({
    company: companySummary(employer),
    emails: [
      {
        id: 'e1',
        address: 'jean@exemple.example',
        is_primary: true,
        is_active: true,
        verification_status: 'verified',
        last_verified_at: VERIFIED,
        origin_type: 'manual',
        source_reference: null,
        imported_unverified: false,
      },
    ],
    ...fields,
  })
}

async function open(detail: Prospect) {
  const api = stubProspectsApi({ details: [detail], companies: [employer, other] })
  renderProspectEditor(detail.id)
  await screen.findByRole('textbox', { name: 'Prénom' })
  return api
}

function region(name: string) {
  return screen.getByRole('region', { name })
}

describe('Prospect editor — e-mails and phones', () => {
  it('adds a second e-mail and makes it the primary one', async () => {
    const api = await open(person())
    const emails = region('E-mails')

    await userEvent.click(within(emails).getByRole('button', { name: 'Ajouter un e-mail' }))
    const added = within(emails).getAllByRole('textbox', { name: 'Adresse e-mail' })[1]
    expect(added).toHaveFocus()
    await fill(added as HTMLElement, 'j.nouveau@exemple.example')
    await userEvent.click(within(emails).getAllByRole('radio', { name: 'Principal' })[1] as HTMLElement)
    await userEvent.click(screen.getByRole('button', { name: 'Enregistrer' }))

    await screen.findByText('Prospect enregistré.')
    const body = lastBody(api.requests, 'PUT') as ProspectInput
    expect(body.emails.map(({ id, address, is_primary }) => ({ id, address, is_primary }))).toEqual([
      { id: 'e1', address: 'jean@exemple.example', is_primary: false },
      { id: null, address: 'j.nouveau@exemple.example', is_primary: true },
    ])
  })

  it('deactivating the primary hands the flag on; removal is in the actions menu', async () => {
    await open(person({ phones: [phone('p1', '+33612345678', { is_primary: true }), phone('p2', '+33123456789', { type: 'landline' })] }))
    const phones = region('Téléphones')

    await userEvent.click(within(phones).getByRole('button', { name: 'Autres actions : Téléphone 1' }))
    await userEvent.click(screen.getByRole('menuitem', { name: 'Désactiver (ancien numéro)' }))

    const [first, second] = within(phones).getAllByRole('radio', { name: 'Principal' })
    expect(first).toBeDisabled()
    expect(second).toBeChecked()
    expect(phones).toHaveTextContent('Ancien numéro (inactif)')

    await userEvent.click(within(phones).getByRole('button', { name: 'Autres actions : Téléphone 1' }))
    await userEvent.click(screen.getByRole('menuitem', { name: 'Retirer (erreur de saisie)' }))
    expect(within(phones).getAllByRole('textbox', { name: 'Numéro' })).toHaveLength(1)
    expect(within(phones).getByRole('button', { name: 'Ajouter un téléphone' })).toHaveFocus()
  })

  it('types a new number with the numbering plan and marks an e-mail invalid', async () => {
    await open(person())
    const phones = region('Téléphones')

    await userEvent.click(within(phones).getByRole('button', { name: 'Ajouter un téléphone' }))
    await userEvent.type(within(phones).getByRole('textbox', { name: 'Numéro' }), '01 23 45 67 89')
    expect(within(phones).getByRole('combobox', { name: 'Type' })).toHaveValue('landline')

    await userEvent.click(within(region('E-mails')).getByRole('button', { name: 'Autres actions : E-mail 1' }))
    await userEvent.click(screen.getByRole('menuitem', { name: 'Marquer invalide' }))
    expect(region('E-mails')).toHaveTextContent('Invalide')
  })

  it('shows the effect of a company change before saving it', async () => {
    const api = await open(person({ verification_state: 'verified', employment_verified_at: VERIFIED }))

    const picker = screen.getByRole('combobox', { name: /Entreprise/ })
    await userEvent.clear(picker)
    await userEvent.type(picker, 'Autre')
    await userEvent.click(await screen.findByRole('option', { name: /Autre Employeur SAS/ }))

    expect(screen.getByRole('note')).toHaveTextContent('Entreprise modifiée.')
    expect(region('Vérification de l’emploi')).toHaveTextContent('Nouvelle entreprise : emploi à vérifier')
    const emails = region('E-mails')
    expect(emails).toHaveTextContent('À revérifier (vérifié le 1 juin 2026)')
    await waitFor(() => {
      expect(within(emails).getByRole('textbox', { name: 'Adresse e-mail' })).toHaveAccessibleDescription(
        'Domaine différent de celui de l’entreprise (autre.example).',
      )
    })

    await userEvent.click(screen.getByRole('button', { name: 'Enregistrer' }))
    await screen.findByText('Prospect enregistré.')
    const body = lastBody(api.requests, 'PUT') as ProspectInput
    expect(body.company_id).toBe(other.id)
    expect(body.emails[0]).toMatchObject({ verification_status: 'unverified', verified_now: false })
  })
})
