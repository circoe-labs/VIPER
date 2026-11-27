import { screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'

import type { UnsentItem } from '../api/unsent'
import { contactRow, message, sent, stubContactApi } from '../test/contactApi'
import { renderApp } from '../test/render'

function item(id: string, last_name: string, reason: string, needs_sent_check: boolean): UnsentItem {
  return {
    prospect_id: id,
    first_name: 'Camille',
    last_name,
    company_name: 'Alpha SARL',
    cohort_code: 'S41',
    status: 'validated',
    revision: 1,
    kind: 'missed',
    send: { state: 'missed', rank: 0, step: 'contact', step_label: 'Contact', scheduled_at: '2026-11-24T07:00:00Z', reason, at: '2026-11-24T07:00:05Z', draft_missing: false, needs_sent_check },
  }
}

const UNSENT = {
  items: [item('p1', 'Sûre', 'dispatch_overdue', false), item('p2', 'Doute', 'send_not_confirmed', true)],
  unverified_drafts: 0,
}

describe('Contact › Envois à reprendre', () => {
  it('asks the person to attest the sent items before the editor schedules a doubtful mail again', async () => {
    const user = userEvent.setup()
    const row = contactRow('Camille', 'Doute', { messages: { contact: 'validated' } })
    const validated = message('contact', 'validated', { prospect_id: row.id, needs_sent_check: true, missed_scheduled_at: '2026-09-24T07:00:00Z', missed_reason: 'send_not_confirmed' })
    const api = stubContactApi({ rows: [row], messages: { [row.id]: { contact: validated } } })
    renderApp(`/contact?prospect=${row.id}`)
    await user.click(await screen.findByRole('button', { name: /^Programmer/ }))
    const next = new Date(Date.now() + 3 * 86_400_000).toISOString().slice(0, 10)
    await user.type(screen.getByLabelText('Date d’envoi'), next)
    await user.type(screen.getByLabelText('Heure'), '08:00')
    await user.click(screen.getByRole('button', { name: 'Programmer l’envoi…' }))
    const dialog = within(screen.getByRole('dialog', { name: /Programmer le message/ }))
    expect(dialog.getByText(/Vérifiez le dossier Envoyés/)).toBeInTheDocument()
    await user.click(dialog.getByRole('button', { name: /J’ai vérifié les Envoyés/ }))
    const [request] = sent(api.requests, 'POST', `/api/prospects/${row.id}/messages/contact/schedule`)
    expect(request?.body).toMatchObject({ sent_check_confirmed: true })
  })

  it('lists what did not leave and reschedules a doubtful one only after the sent items are confirmed', async () => {
    const user = userEvent.setup()
    const api = stubContactApi({ unsent: UNSENT })
    renderApp('/contact')
    const panel = within(await screen.findByRole('region', { name: 'Envois à reprendre' }))
    const rows = panel.getAllByRole('listitem')
    expect(rows[0]).toHaveTextContent('Contact prévu le 24 nov. 2026')
    expect(rows[0]).toHaveTextContent('heure dépassée')
    expect(rows[1]).toHaveTextContent('Vérifier les Envoyés')

    // « Select the safe ones » never takes a doubtful one along.
    await user.click(panel.getByRole('button', { name: 'Sélectionner les 1 sans doute possible' }))
    expect(panel.getByRole('checkbox', { name: /Camille Doute/ })).not.toBeChecked()
    expect(panel.queryByRole('checkbox', { name: /J’ai vérifié/ })).not.toBeInTheDocument()

    await user.click(panel.getByRole('button', { name: 'Ajouter les 1 à vérifier' }))
    const submit = panel.getByRole('button', { name: 'Reprogrammer 2 messages' })
    expect(submit).toBeDisabled()
    await user.type(panel.getByLabelText('Nouvelle date d’envoi'), '2099-01-05')
    await user.type(panel.getByLabelText(/^Heure/), '08:00')
    expect(sent(api.requests, 'POST', '/api/contact/unsent/reschedule')).toHaveLength(0)
    await user.click(panel.getByRole('checkbox', { name: /J’ai vérifié le dossier Envoyés/ }))
    // A year ahead at most: said, nothing sent.
    await user.click(submit)
    expect(panel.getByRole('alert')).toHaveTextContent('plus d’un an')

    const next = new Date(Date.now() + 3 * 86_400_000).toISOString().slice(0, 10)
    await user.clear(panel.getByLabelText('Nouvelle date d’envoi'))
    await user.type(panel.getByLabelText('Nouvelle date d’envoi'), next)
    await user.click(submit)
    expect(await panel.findByText(/2 messages reprogrammés/)).toBeInTheDocument()
    const [request] = sent(api.requests, 'POST', '/api/contact/unsent/reschedule')
    expect((request?.body as { items: unknown[] }).items).toEqual([
      { prospect_id: 'p1', rank: 0, expected_revision: 1, sent_check_confirmed: false },
      { prospect_id: 'p2', rank: 0, expected_revision: 1, sent_check_confirmed: true },
    ])
  })
})
