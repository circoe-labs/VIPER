import { screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'

import type { ProspectInput } from '../api/prospects'
import { company } from '../test/companiesApi'
import { companySummary, lastBody, prospectDetail, stubProspectsApi } from '../test/prospectsApi'
import { renderProspectEditor } from '../test/renderProspectEditor'
import { taxonomyValue } from '../test/settingsApi'

const employer = company('Transports Exemple SARL')

async function open() {
  const detail = prospectDetail({ company: companySummary(employer) })
  const api = stubProspectsApi({ details: [detail], companies: [employer], roles: [taxonomyValue('Dirigeant')] })
  renderProspectEditor(detail.id)
  await screen.findByRole('textbox', { name: 'Prénom' })
  return api
}

describe('Prospect editor — role and contact tracking', () => {
  it('creates a missing role with the save, not before', async () => {
    const api = await open()

    await userEvent.type(screen.getByRole('combobox', { name: 'Rôle' }), 'Chef de flux')
    await userEvent.click(await screen.findByRole('option', { name: 'Créer le rôle « Chef de flux »' }))

    expect(screen.getByRole('combobox', { name: 'Rôle' })).toHaveAccessibleDescription(
      '« Chef de flux » sera ajouté aux rôles à l’enregistrement, pour tous les prospects.',
    )
    expect(api.requests.filter((request) => request.method === 'POST')).toEqual([])
    await userEvent.click(screen.getByRole('button', { name: 'Enregistrer' }))
    await screen.findByText('Prospect enregistré.')
    expect(lastBody(api.requests, 'PUT')).toMatchObject({ role_id: null, role_label: 'Chef de flux' })
  })

  it('plans a contact with its week, and asks for the referent once an appointment exists', async () => {
    const api = await open()
    const tracking = screen.getByRole('region', { name: 'Suivi de contact' })

    await userEvent.click(within(tracking).getByRole('button', { name: 'Dans 1 semaine' }))
    // The prospect's business day is 2026-09-11 (fake API).
    expect(within(tracking).getByLabelText('Contact prévu le')).toHaveValue('2026-09-18')
    expect(tracking).toHaveTextContent('Semaine 38')
    await userEvent.selectOptions(within(tracking).getByRole('combobox', { name: 'Étape' }), 'Rendez-vous obtenu')
    expect(within(tracking).getByRole('combobox', { name: 'Référent Circoe' })).toHaveAccessibleDescription(
      'Rendez-vous obtenu : indiquez qui le prend en charge chez Circoe.',
    )

    await userEvent.click(screen.getByRole('button', { name: 'Enregistrer' }))
    await screen.findByText('Prospect enregistré.')
    expect((lastBody(api.requests, 'PUT') as ProspectInput).tracking).toEqual({
      status: 'appointment_obtained',
      planned_contact_on: '2026-09-18',
      response_received_on: null,
      appointment_on: null,
      appointment_time: null,
      referent_id: null,
    })
  })
})
