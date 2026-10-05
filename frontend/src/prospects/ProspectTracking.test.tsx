import { screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'

import type { Prospect, ProspectInput } from '../api/prospects'
import { company } from '../test/companiesApi'
import { companySummary, lastBody, prospectDetail, stubProspectsApi, trackingDetail } from '../test/prospectsApi'
import { renderProspectEditor } from '../test/renderProspectEditor'
import { taxonomyValue } from '../test/settingsApi'

const employer = company('Transports Exemple SARL')

async function open(fields: Partial<Prospect> = {}) {
  const detail = prospectDetail({ company: companySummary(employer), ...fields })
  const api = stubProspectsApi({ details: [detail], companies: [employer], roles: [taxonomyValue('Dirigeant')] })
  renderProspectEditor(detail.id)
  await screen.findByRole('textbox', { name: 'Prénom' })
  return api
}

function section() {
  return screen.getByRole('region', { name: 'Suivi de contact' })
}

async function save() {
  await userEvent.click(screen.getByRole('button', { name: 'Enregistrer' }))
  await screen.findByText('Prospect enregistré.')
}

function savedTracking(api: Awaited<ReturnType<typeof open>>) {
  return (lastBody(api.requests, 'PUT') as ProspectInput).tracking
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
    await save()
    expect(lastBody(api.requests, 'PUT')).toMatchObject({ role_id: null, role_label: 'Chef de flux' })
  })

  it('offers the commercial states — « Défaillant » only once saved — and saves no planned day', async () => {
    const api = await open({ tracking: trackingDetail({ status: 'response_received' }) })
    const state = within(section()).getByRole('combobox', { name: 'État commercial' })
    expect(within(state).getAllByRole('option').map((option) => option.textContent)).toEqual([
      'En séquence',
      'Réponse reçue',
      'RDV pris',
      'Ignoré',
    ])

    await userEvent.selectOptions(state, 'En séquence')
    expect(state).toHaveAccessibleDescription('La séquence reprend là où elle s’était arrêtée (le niveau est conservé).')
    await save()
    expect(savedTracking(api)).toEqual({
      status: 'neutral',
      response_received_on: null,
      appointment_on: null,
      appointment_time: null,
      referent_id: null,
    })
  })

  it('shows a saved « Défaillant » so the form can leave it', async () => {
    await open({ tracking: trackingDetail({ status: 'disqualified' }) })
    const state = within(section()).getByRole('combobox', { name: 'État commercial' })

    expect(state).toHaveDisplayValue('Défaillant')
    expect(within(state).getAllByRole('option')).toHaveLength(5)
  })

  it('asks for the referent once RDV pris', async () => {
    await open({ tracking: trackingDetail({ status: 'neutral' }) })
    const tracking = section()
    const state = within(tracking).getByRole('combobox', { name: 'État commercial' })

    await userEvent.selectOptions(state, 'RDV pris')

    expect(state).toHaveAccessibleDescription('Fin de la séquence de contact : indiquez le référent qui prend le rendez-vous.')
    expect(within(tracking).getByRole('combobox', { name: 'Référent Circoe' })).toHaveAccessibleDescription(
      'RDV pris : indiquez qui le prend en charge chez Circoe.',
    )
  })

  it('says « Ignoré » is final before saving', async () => {
    await open({ tracking: trackingDetail({ status: 'neutral' }) })
    const state = within(section()).getByRole('combobox', { name: 'État commercial' })

    await userEvent.selectOptions(state, 'Ignoré')

    expect(state).toHaveAccessibleDescription(
      'Définitif : le prospect passe en « Ne pas contacter » et n’aura plus d’envoi.',
    )
  })

  it('keeps a saved « Ignoré » locked, opposition included', async () => {
    await open({
      contactability_status: 'do_not_contact',
      do_not_contact_at: '2026-09-10T08:00:00+00:00',
      do_not_contact_reason: 'Prospect ignoré (état Contact).',
      tracking: trackingDetail({ status: 'ignored' }),
    })
    const state = within(section()).getByRole('combobox', { name: 'État commercial' })

    expect(state).toBeDisabled()
    expect(state).toHaveAccessibleDescription('« Ignoré » est définitif : l’état ne peut plus changer.')
    // The opposition stays on the profile: the contact summary says no send is possible.
    expect(section()).toHaveTextContent('Opposition enregistrée : aucun envoi n’est possible.')
  })

  it('says why the server refused a Contact rule', async () => {
    const api = await open({ tracking: trackingDetail({ status: 'neutral' }) })
    await userEvent.selectOptions(within(section()).getByRole('combobox', { name: 'État commercial' }), 'Réponse reçue')

    api.next.reply = [409, { code: 'ignored_is_terminal', message: 'An ignored prospect keeps its state.' }]
    await userEvent.click(screen.getByRole('button', { name: 'Enregistrer' }))

    expect(
      await screen.findByText('Ce prospect est « Ignoré » : c’est définitif, son état ne change plus et son opposition reste enregistrée.'),
    ).toBeInTheDocument()
  })
})
