import { screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'

import type { Prospect, ProspectInput } from '../api/prospects'
import { company } from '../test/companiesApi'
import { companySummary, lastBody, prospectDetail, stubProspectsApi, trackingDetail } from '../test/prospectsApi'
import { editorReady, editSection, showTab } from '../test/prospectEditorUi'
import { renderProspectEditor } from '../test/renderProspectEditor'
import { taxonomyValue } from '../test/settingsApi'

const employer = company('Transports Exemple SARL')

// The fake API's business day is 2026-09-11, a Friday of week 37.
// `tab`: the tab the test works on (the role is on Profil, the contact tracking on Suivi).
async function open(fields: Partial<Prospect> = {}, tab: 'Profil' | 'Suivi' = 'Suivi') {
  const detail = prospectDetail({ company: companySummary(employer), ...fields })
  const api = stubProspectsApi({ details: [detail], companies: [employer], roles: [taxonomyValue('Dirigeant')] })
  renderProspectEditor(detail.id)
  await editorReady()
  if (tab === 'Suivi') await showTab('Suivi')
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
    const api = await open({}, 'Profil')
    await editSection('Emploi')

    await userEvent.type(screen.getByRole('combobox', { name: 'Rôle' }), 'Chef de flux')
    await userEvent.click(await screen.findByRole('option', { name: 'Créer le rôle « Chef de flux »' }))

    expect(screen.getByRole('combobox', { name: 'Rôle' })).toHaveAccessibleDescription(
      '« Chef de flux » sera ajouté aux rôles à l’enregistrement, pour tous les prospects.',
    )
    expect(api.requests.filter((request) => request.method === 'POST')).toEqual([])
    await save()
    expect(lastBody(api.requests, 'PUT')).toMatchObject({ role_id: null, role_label: 'Chef de flux' })
  })

  it('plans a week without choosing a state: the tracking starts neutral, stored on the week’s Monday', async () => {
    const api = await open()
    const tracking = section()
    const planner = within(tracking).getByRole('group', { name: 'Prochaine action' })
    expect(planner).toHaveTextContent('Aucune semaine planifiée')

    await userEvent.click(within(planner).getByRole('button', { name: '+1 semaine' }))

    expect(planner).toHaveTextContent('S38')
    expect(planner).toHaveTextContent('Semaine du lun. 14 sept. 2026 · dans 1 semaine')
    expect(within(planner).getByRole('button', { name: '+1 semaine' })).toHaveAttribute('aria-pressed', 'true')
    await save()
    expect(savedTracking(api)).toEqual({
      status: 'neutral',
      planned_contact_on: '2026-09-14',
      response_received_on: null,
      appointment_on: null,
      appointment_time: null,
      referent_id: null,
    })
  })

  it('picks a week of another year with the selects, and clears it', async () => {
    const api = await open({ tracking: trackingDetail({ status: 'contacted', planned_contact_on: '2026-09-14', planned_contact_week: '2026-W38' }) })
    const planner = within(section()).getByRole('group', { name: 'Prochaine action' })

    await userEvent.selectOptions(within(planner).getByRole('combobox', { name: 'Année' }), '2027')
    await userEvent.selectOptions(within(planner).getByRole('combobox', { name: 'Semaine' }), 'S01 · lun. 4 janv.')
    expect(planner).toHaveTextContent('S01 · 2027')
    await save()
    expect(savedTracking(api)).toMatchObject({ status: 'contacted', planned_contact_on: '2027-01-04' })

    await userEvent.click(within(planner).getByRole('button', { name: 'Effacer' }))
    expect(planner).toHaveTextContent('Aucune semaine planifiée')
    await save()
    expect(savedTracking(api)).toMatchObject({ status: 'contacted', planned_contact_on: null })
  })

  it('offers the cadence week in one click, never applied by itself', async () => {
    const api = await open({
      tracking: trackingDetail({
        status: 'r1',
        planned_contact_on: '2026-09-07',
        planned_contact_week: '2026-W37',
        status_since: '2026-09-10T08:00:00+00:00',
        suggested_next_contact_on: '2026-09-21',
        suggested_next_contact_week: '2026-W39',
      }),
    })
    const planner = within(section()).getByRole('group', { name: 'Prochaine action' })
    // Loaded as stored: the proposal is only offered.
    expect(planner).toHaveTextContent('Semaine du lun. 7 sept. 2026 · cette semaine')

    await userEvent.click(within(planner).getByRole('button', { name: 'Appliquer la cadence : S39 (relance après R1)' }))
    expect(planner).toHaveTextContent('Semaine conforme à la cadence (relance après R1).')
    await save()
    expect(savedTracking(api)).toMatchObject({ status: 'r1', planned_contact_on: '2026-09-21' })

    // Another state than the saved one: the server's proposal no longer applies.
    await userEvent.selectOptions(within(section()).getByRole('combobox', { name: 'État' }), 'R2')
    expect(within(planner).queryByText(/cadence/)).toBeNull()
  })

  it('shows the effect of a state before saving, and asks for the referent once RDV pris', async () => {
    const api = await open({
      tracking: trackingDetail({ status: 'r2', planned_contact_on: '2026-09-14', planned_contact_week: '2026-W38' }),
    })
    const tracking = section()
    const state = within(tracking).getByRole('combobox', { name: 'État' })
    expect(within(state).getAllByRole('option').map((option) => option.textContent)).toEqual([
      'Aucun état',
      'Contacté',
      'R1',
      'R2',
      'Réponse reçue',
      'RDV pris',
      'Failure',
      'Ignoré',
    ])

    await userEvent.selectOptions(state, 'RDV pris')
    // The stored week goes with a state that ends the sequence (the server does the same).
    expect(tracking).toHaveTextContent('Aucune semaine planifiée')
    expect(state).toHaveAccessibleDescription('Fin de la séquence de contact : indiquez le référent qui prend le rendez-vous.')
    expect(within(tracking).getByRole('combobox', { name: 'Référent Circoe' })).toHaveAccessibleDescription(
      'RDV pris : indiquez qui le prend en charge chez Circoe.',
    )
    expect(tracking).toHaveTextContent('Réponse reçue, RDV pris et Failure retirent la semaine enregistrée')
    // Back to R2 before saving: the stored week comes back.
    await userEvent.selectOptions(state, 'R2')
    expect(tracking).toHaveTextContent('S38')
    await userEvent.selectOptions(state, 'RDV pris')
    await save()
    expect(savedTracking(api)).toMatchObject({ status: 'appointment_obtained', planned_contact_on: null })
  })

  it('closes the planner on « Ignoré », says it is final, and keeps a saved « Ignoré » as it is', async () => {
    await open({ tracking: trackingDetail({ status: 'contacted', planned_contact_on: '2026-09-14', planned_contact_week: '2026-W38' }) })
    const tracking = section()

    await userEvent.selectOptions(within(tracking).getByRole('combobox', { name: 'État' }), 'Ignoré')

    expect(within(tracking).queryByRole('group', { name: 'Prochaine action' })).toBeNull()
    expect(tracking).toHaveTextContent('Prospect ignoré : aucune prochaine action ne peut être planifiée.')
    expect(within(tracking).getByRole('combobox', { name: 'État' })).toHaveAccessibleDescription(
      'Définitif : le prospect passe en « Ne pas contacter » et n’aura plus de prochaine action.',
    )
  })

  it('keeps a saved « Ignoré » locked, opposition included', async () => {
    await open({
      contactability_status: 'do_not_contact',
      do_not_contact_at: '2026-09-10T08:00:00+00:00',
      do_not_contact_reason: 'Prospect ignoré (état Contact).',
      tracking: trackingDetail({ status: 'ignored' }),
    })
    const state = within(section()).getByRole('combobox', { name: 'État' })

    expect(state).toBeDisabled()
    expect(state).toHaveAccessibleDescription('« Ignoré » est définitif : l’état ne peut plus changer.')
    const opposition = screen.getByRole('region', { name: 'Opposition' })
    expect(within(opposition).queryByRole('button', { name: 'Lever l’opposition…' })).toBeNull()
    expect(opposition).toHaveTextContent('l’opposition est définitive et ne peut pas être levée')
  })

  it('says why the server refused a Contact rule', async () => {
    const api = await open({ tracking: trackingDetail({ status: 'contacted' }) })
    await userEvent.selectOptions(within(section()).getByRole('combobox', { name: 'État' }), 'R1')

    api.next.reply = [409, { code: 'ignored_is_terminal', message: 'An ignored prospect keeps its state.' }]
    await userEvent.click(screen.getByRole('button', { name: 'Enregistrer' }))

    expect(
      await screen.findByText('Ce prospect est « Ignoré » : c’est définitif, son état ne change plus et son opposition reste enregistrée.'),
    ).toBeInTheDocument()
  })
})
