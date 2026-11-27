import { screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'

import type { UnsentItem } from '../api/unsent'
import { contactRow, message, sent, stubContactApi } from '../test/contactApi'
import { renderApp } from '../test/render'

function item(id: string, last_name: string, reason: string, needs_sent_check: boolean): UnsentItem {
  return {
    message_id: `message-${id}`,
    current: true,
    prospect_id: id,
    first_name: 'Camille',
    last_name,
    company_name: 'Alpha SARL',
    cohort_code: 'S41',
    status: 'validated',
    revision: 1,
    kind: needs_sent_check ? 'doubt' : 'missed',
    send: { state: needs_sent_check ? 'doubt' : 'missed', rank: 0, step: 'contact', step_label: 'Contact', scheduled_at: '2026-11-24T07:00:00Z', reason, at: '2026-11-24T07:00:05Z', draft_missing: false, needs_sent_check },
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

  it('keeps the doubtful ones apart and names what each confirmation covers', async () => {
    const user = userEvent.setup()
    const api = stubContactApi({ unsent: UNSENT })
    renderApp('/contact')
    const panel = within(await screen.findByRole('region', { name: 'Envois à reprendre' }))
    const safe = within(panel.getByRole('list', { name: 'Mails non partis' }))
    expect(safe.getByRole('listitem')).toHaveTextContent('Contact prévu le 24 nov. 2026')
    expect(safe.getByRole('listitem')).toHaveTextContent('heure dépassée')
    const doubtful = within(panel.getByRole('list', { name: 'Peut-être partis : à vérifier' }))
    expect(doubtful.getByRole('listitem')).toHaveTextContent('Peut-être parti')
    expect(doubtful.queryByText(/Camille Sûre/)).not.toBeInTheDocument()

    await user.click(doubtful.getByRole('checkbox', { name: /Camille Doute/ }))
    const submit = panel.getByRole('button', { name: 'Reprogrammer 1 message' })
    const clear = panel.getByRole('button', { name: 'Confirmer sans reprogrammer (1)' })
    expect(submit).toBeDisabled()
    expect(clear).toBeDisabled()
    expect(within(panel.getByRole('list', { name: 'Mails couverts par la confirmation' })).getByRole('listitem')).toHaveTextContent('Camille Doute · Contact')
    await user.click(panel.getByRole('checkbox', { name: /le mail ci-dessous n’est pas parti/ }))
    // A year ahead at most: said, nothing sent.
    await user.type(panel.getByLabelText('Nouvelle date d’envoi'), '2099-01-05')
    await user.type(panel.getByLabelText(/^Heure/), '08:00')
    await user.click(submit)
    expect(panel.getByRole('alert')).toHaveTextContent('plus d’un an')
    expect(sent(api.requests, 'POST', '/api/contact/unsent/reschedule')).toHaveLength(0)

    const next = new Date(Date.now() + 3 * 86_400_000).toISOString().slice(0, 10)
    await user.clear(panel.getByLabelText('Nouvelle date d’envoi'))
    await user.type(panel.getByLabelText('Nouvelle date d’envoi'), next)
    await user.click(submit)
    expect(await panel.findByText(/1 message reprogrammé/)).toBeInTheDocument()
    const [request] = sent(api.requests, 'POST', '/api/contact/unsent/reschedule')
    expect((request?.body as { items: unknown[] }).items).toEqual([
      { prospect_id: 'p2', rank: 0, expected_revision: 1, sent_check_confirmed: true },
    ])

    await user.click(doubtful.getByRole('checkbox', { name: /Camille Doute/ }))
    await user.click(panel.getByRole('checkbox', { name: /le mail ci-dessous/ }))
    await user.click(panel.getByRole('button', { name: 'Confirmer sans reprogrammer (1)' }))
    const [confirmed] = sent(api.requests, 'POST', '/api/contact/unsent/confirm-not-sent')
    expect(confirmed?.body).toEqual({ items: [{ message_id: 'message-p2', expected_revision: 1 }] })
  })
  it('keeps two mails of one step apart, and records what no sheet can mark as sent', async () => {
    const user = userEvent.setup()
    const old: UnsentItem = { ...item('p3', 'Double', 'send_not_confirmed', true), message_id: 'message-old', current: false, status: 'cancelled' }
    const now: UnsentItem = { ...item('p3', 'Double', 'send_not_confirmed', true), message_id: 'message-new' }
    const base = item('p4', 'Ancienne', 'send_not_confirmed', true)
    const third: UnsentItem = { ...base, status: 'cancelled', send: { ...base.send, rank: 3, step: 'r3', step_label: 'R3' } }
    const api = stubContactApi({ unsent: { items: [old, now, third], unverified_drafts: 0 } })
    renderApp('/contact')
    const panel = within(await screen.findByRole('region', { name: 'Envois à reprendre' }))
    const boxes = panel.getAllByRole('checkbox', { name: /Camille Double/ })
    const [first, second] = boxes
    if (!first || !second) throw new Error('two rows expected')
    await user.click(first)
    expect(second).not.toBeChecked()

    // The former week's mail and the R3 offer it: the current one is marked on its sheet.
    expect(panel.getAllByRole('button', { name: /^Marquer comme envoyé/ })).toHaveLength(2)
    await user.click(panel.getByRole('button', { name: /Marquer comme envoyé : Camille Ancienne · R3/ }))
    await user.click(within(screen.getByRole('dialog', { name: /comme envoyé/ })).getByRole('button', { name: 'Marquer envoyé' }))
    expect(await panel.findByText(/enregistré comme envoyé/)).toBeInTheDocument()
    const [request] = sent(api.requests, 'POST', '/api/contact/unsent/record-sent')
    expect(request?.body).toEqual({ message_id: 'message-p4', expected_revision: 1 })
  })
})
