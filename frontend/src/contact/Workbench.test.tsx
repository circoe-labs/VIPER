import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'

import type { Message, MessageStep } from '../api/contact'
import type { Prospect } from '../api/prospects'
import { contactDashboard, message, sent, stubContactApi } from '../test/contactApi'
import { prospectDetail, trackingDetail } from '../test/prospectsApi'
import { renderApp } from '../test/render'

// The Contact workbench against the Contact fake (test/contactApi.ts): the sheet, the manual state and week, and the
// mail editor's state machine as the operator drives it.

function person(fields: Partial<Prospect> = {}): Prospect {
  return prospectDetail({
    civility: 'ms',
    first_name: 'Claire',
    last_name: 'Démo',
    emails: [
      {
        id: 'email-1',
        address: 'claire@exemple.example',
        is_primary: true,
        is_active: true,
        verification_status: 'verified',
        last_verified_at: null,
        origin_type: 'manual',
        source_reference: null,
        imported_unverified: false,
      },
    ],
    tracking: trackingDetail({ status: 'neutral' }),
    today: '2026-09-30',
    ...fields,
  })
}

function open(detail: Prospect, messages: Partial<Record<MessageStep, Message>> = {}, extra: Parameters<typeof stubContactApi>[0] = {}) {
  const api = stubContactApi({
    dashboard: contactDashboard(),
    details: [detail],
    messages: { [detail.id]: messages },
    defaults: { from_email: 'prospection@exemple.example', to: ['claire@exemple.example'], generation_available: false },
    ...extra,
  })
  const view = renderApp(`/contact?prospect=${detail.id}`)
  return { api, ...view }
}

function tab(step: string) {
  return within(screen.getByRole('tablist', { name: 'Étapes de la séquence' })).getByRole('tab', { name: new RegExp(`^${step}`) })
}

function field(name: string) {
  return screen.getByRole('textbox', { name })
}

async function confirmDialog(title: RegExp, button: string) {
  const dialog = await screen.findByRole('dialog', { name: title })
  await userEvent.click(within(dialog).getByRole('button', { name: button }))
}

function announced() {
  return screen.getAllByRole('status').map((status) => status.textContent).join(' ')
}

describe('Contact workbench', () => {
  it('shows the prospect sheet on the left, read-only, with a link to the full record', async () => {
    const detail = person({ contactability_status: 'contactable' })
    open(detail)
    const sheet = screen.getByRole('complementary', { name: 'Fiche du prospect' })
    const heading = await within(sheet).findByRole('heading', { level: 2, name: /Claire Démo/ })
    // Opening a prospect puts the focus on the person.
    expect(heading).toHaveFocus()
    expect(sheet).toHaveTextContent('claire@exemple.example')
    expect(sheet).toHaveTextContent('Vérifié')
    expect(within(sheet).getByRole('link', { name: 'Ouvrir dans Prospection' })).toHaveAttribute(
      'href',
      `/prospection?prospect=${detail.id}`,
    )
    // Nothing edits the record from the sheet but the follow-up.
    expect(within(sheet).queryByRole('textbox')).not.toBeInTheDocument()
  })

  it('starts an empty step from the defaults and creates the draft on save (never validated)', async () => {
    const detail = person()
    const { api } = open(detail)
    expect(await screen.findByRole('tab', { name: /^Contact/ })).toHaveAttribute('aria-selected', 'true')
    expect(tab('Contact')).toHaveTextContent('Vide')
    expect(field('De')).toHaveValue('prospection@exemple.example')
    expect(field('À')).toHaveValue('claire@exemple.example')
    expect(screen.queryByRole('button', { name: 'Valider…' })).not.toBeInTheDocument()

    await userEvent.type(field('Objet'), 'Bonjour')
    await userEvent.type(field('Corps'), 'Un message de test.')
    await userEvent.click(screen.getByRole('button', { name: 'Créer le brouillon' }))

    await waitFor(() => {
      expect(tab('Contact')).toHaveTextContent('Brouillon')
    })
    expect(announced()).toContain('Brouillon Contact créé.')
    const [put] = sent(api.requests, 'PUT', `/api/prospects/${detail.id}/messages/contact`)
    expect(put?.body).toEqual({
      from_email: 'prospection@exemple.example',
      subject: 'Bonjour',
      body_text: 'Un message de test.',
      to: ['claire@exemple.example'],
      cc: [],
      bcc: [],
    })
    expect(sent(api.requests, 'POST', `/api/prospects/${detail.id}/messages/contact/validate`)).toHaveLength(0)
  })

  it('validates after a confirmation, then schedules a typed date and time after another', async () => {
    const detail = person()
    const { api } = open(detail, { contact: message('contact', 'draft', { prospect_id: detail.id }) })
    await userEvent.click(await screen.findByRole('button', { name: 'Valider…' }))
    const dialog = await screen.findByRole('dialog', { name: /Valider le message Contact/ })
    expect(dialog).toHaveTextContent('Rien n’est envoyé maintenant')
    // « Retour » is focused first: Enter never confirms by accident.
    expect(within(dialog).getByRole('button', { name: 'Retour' })).toHaveFocus()
    await userEvent.click(within(dialog).getByRole('button', { name: 'Valider le message' }))
    await waitFor(() => {
      expect(tab('Contact')).toHaveTextContent('Validé')
    })
    // « Valider… » is gone: the focus lands on the status sentence, which reads the new status.
    await waitFor(() => {
      expect(screen.getByText(/prêt à être programmé/)).toHaveFocus()
    })

    // No default time: « Programmer… » without a date and time says what is missing.
    await userEvent.click(screen.getByRole('button', { name: 'Programmer…' }))
    expect(screen.getByRole('alert')).toHaveTextContent('Choisissez la date et l’heure d’envoi.')
    const tomorrow = new Date(Date.now() + 86_400_000)
    const day = `${String(tomorrow.getFullYear())}-${String(tomorrow.getMonth() + 1).padStart(2, '0')}-${String(tomorrow.getDate()).padStart(2, '0')}`
    await userEvent.type(screen.getByLabelText('Date d’envoi'), day)
    await userEvent.type(screen.getByLabelText('Heure'), '09:30')
    // The typed moment survives a tab switch.
    await userEvent.click(tab('R1'))
    await userEvent.click(tab('Contact'))
    expect(screen.getByLabelText('Date d’envoi')).toHaveValue(day)
    expect(screen.getByLabelText('Heure')).toHaveValue('09:30')
    await userEvent.click(screen.getByRole('button', { name: 'Programmer…' }))
    await confirmDialog(/Programmer le message Contact/, 'Programmer l’envoi')
    await waitFor(() => {
      expect(tab('Contact')).toHaveTextContent('Programmé')
    })
    const [schedule] = sent(api.requests, 'POST', `/api/prospects/${detail.id}/messages/contact/schedule`)
    const body = schedule?.body as { expected_revision: number; scheduled_at: string }
    expect(body.expected_revision).toBe(1)
    expect(body.scheduled_at).toMatch(new RegExp(`^${day}T09:30:00[+-]\\d{2}:\\d{2}$`))

    await userEvent.click(screen.getByRole('button', { name: 'Déprogrammer' }))
    await waitFor(() => {
      expect(tab('Contact')).toHaveTextContent('Validé')
    })
    expect(announced()).toContain('il reste validé')
  })

  it('says an edit of a scheduled message goes back to draft, and it does', async () => {
    const detail = person()
    const { api } = open(detail, { contact: message('contact', 'scheduled', { prospect_id: detail.id }) })
    await userEvent.type(await screen.findByRole('textbox', { name: 'Objet' }), ' modifié')
    expect(screen.getByRole('note')).toHaveTextContent('l’enregistrer retire la programmation')
    expect(screen.getByRole('button', { name: 'Déprogrammer' })).toBeDisabled()
    await userEvent.click(screen.getByRole('button', { name: 'Enregistrer' }))
    await waitFor(() => {
      expect(tab('Contact')).toHaveTextContent('Brouillon')
    })
    expect(announced()).toContain('repassé en Brouillon : à revalider')
    const [put] = sent(api.requests, 'PUT', `/api/prospects/${detail.id}/messages/contact`)
    expect(put?.body).toMatchObject({ expected_revision: 1, subject: 'Objet contact modifié' })
  })

  it('warns, without blocking, when R1 is scheduled before Contact has left', async () => {
    const detail = person()
    open(detail, {
      contact: message('contact', 'validated', { prospect_id: detail.id }),
      r1: message('r1', 'validated', { prospect_id: detail.id }),
    })
    await userEvent.click(await screen.findByRole('tab', { name: /^R1/ }))
    expect(screen.getByText('Le message Contact est « Validé » : vérifiez que R1 ne partira pas avant lui.')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Programmer…' })).toBeEnabled()
  })

  it('cancels after a confirmation and reopens as a draft', async () => {
    const detail = person()
    open(detail, { contact: message('contact', 'validated', { prospect_id: detail.id }) })
    await userEvent.click(await screen.findByRole('button', { name: 'Annuler le message…' }))
    await confirmDialog(/Annuler le message Contact/, 'Annuler le message')
    await waitFor(() => {
      expect(tab('Contact')).toHaveTextContent('Annulé')
    })
    await waitFor(() => {
      expect(screen.getByText(/^Annulé le/)).toHaveFocus()
    })
    expect(field('Objet')).toHaveAttribute('readonly')
    await userEvent.click(screen.getByRole('button', { name: 'Rouvrir' }))
    await waitFor(() => {
      expect(tab('Contact')).toHaveTextContent('Brouillon')
    })
    expect(field('Objet')).not.toHaveAttribute('readonly')
  })

  it('keeps a sent message read-only, with no action', async () => {
    const detail = person()
    open(detail, { contact: message('contact', 'sent', { prospect_id: detail.id }) })
    expect(await screen.findByText('Message envoyé : il reste consultable mais ne peut plus être modifié.')).toBeInTheDocument()
    for (const name of ['De', 'À', 'Objet', 'Corps']) expect(field(name)).toHaveAttribute('readonly')
    for (const name of ['Enregistrer', 'Valider…', 'Annuler le message…', 'Rouvrir']) {
      expect(screen.queryByRole('button', { name })).not.toBeInTheDocument()
    }
  })

  it('locks the editor of a closed sequence and of an opposition, and says why', async () => {
    const closed = person({ tracking: trackingDetail({ status: 'appointment_obtained' }) })
    open(closed, { contact: message('contact', 'scheduled', { prospect_id: closed.id }) })
    expect(await screen.findByText(/Séquence close par l’état « RDV pris »/)).toBeInTheDocument()
    expect(field('Objet')).toHaveAttribute('readonly')
    expect(screen.getByRole('button', { name: 'Déprogrammer' })).toBeEnabled()
    expect(screen.queryByRole('button', { name: 'Enregistrer' })).not.toBeInTheDocument()
  })

  it('locks the editor of a person in opposition', async () => {
    const blocked = person({ contactability_status: 'do_not_contact', do_not_contact_reason: 'Demande écrite' })
    open(blocked)
    expect(await screen.findByText(/Prospect en opposition/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Créer le brouillon' })).not.toBeInTheDocument()
    expect(screen.getByRole('complementary', { name: 'Fiche du prospect' })).toHaveTextContent('Ne pas contacter')
  })

  it('places an incomplete message’s refusal on its fields', async () => {
    const detail = person()
    open(detail, { contact: message('contact', 'draft', { prospect_id: detail.id, subject: '', body_text: '' }) })
    await userEvent.click(await screen.findByRole('button', { name: 'Valider…' }))
    await confirmDialog(/Valider le message Contact/, 'Valider le message')
    expect(await screen.findByText('Indiquez l’objet.')).toBeInTheDocument()
    expect(screen.getByText('Rédigez le corps du message.')).toBeInTheDocument()
    expect(screen.getByRole('alert')).toHaveTextContent('Message incomplet')
    expect(field('Objet')).toHaveAttribute('aria-invalid', 'true')
  })

  it('keeps the unsaved text when the message changed elsewhere, and reloads the saved version', async () => {
    const detail = person()
    const { api } = open(detail, { contact: message('contact', 'draft', { prospect_id: detail.id }) })
    await userEvent.type(await screen.findByRole('textbox', { name: 'Objet' }), ' (local)')
    api.next.reply = [409, { code: 'revision_conflict', message: 'stale' }]
    const reads = sent(api.requests, 'GET', `/api/prospects/${detail.id}/messages`).length
    await userEvent.click(screen.getByRole('button', { name: 'Enregistrer' }))
    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('l’enregistrer remplacera la version enregistrée')
    expect(field('Objet')).toHaveValue('Objet contact (local)')
    await waitFor(() => {
      expect(sent(api.requests, 'GET', `/api/prospects/${detail.id}/messages`).length).toBeGreaterThan(reads)
    })
    // « Voir la version enregistrée » drops the local text.
    await userEvent.click(within(alert).getByRole('button', { name: 'Voir la version enregistrée' }))
    expect(field('Objet')).toHaveValue('Objet contact')
  })

  it('keeps unsaved text across tabs (marked) and asks before leaving the prospect', async () => {
    const detail = person()
    const { router } = open(detail)
    await userEvent.type(await screen.findByRole('textbox', { name: 'Objet' }), 'Non enregistré')
    await userEvent.click(tab('R1'))
    expect(tab('Contact')).toHaveTextContent('(modifications non enregistrées)')
    await userEvent.click(tab('Contact'))
    expect(field('Objet')).toHaveValue('Non enregistré')

    await userEvent.click(screen.getByRole('button', { name: 'Retour à la liste' }))
    const guard = await screen.findByRole('dialog', { name: 'Modifications non enregistrées' })
    expect(guard).toHaveTextContent('Un message a des modifications non enregistrées.')
    await userEvent.click(within(guard).getByRole('button', { name: 'Rester sur ce prospect' }))
    expect(router.state.location.search).toContain(detail.id)
    expect(field('Objet')).toHaveValue('Non enregistré')

    await userEvent.click(screen.getByRole('button', { name: 'Retour à la liste' }))
    await userEvent.click(
      within(await screen.findByRole('dialog', { name: 'Modifications non enregistrées' })).getByRole('button', {
        name: 'Quitter sans enregistrer',
      }),
    )
    await waitFor(() => {
      expect(router.state.location.search).toBe('')
    })
  })

  it('confirms a sequence-closing state, then patches the state alone (the week is cleared by the server)', async () => {
    const detail = person()
    const { api } = open(detail)
    const state = await screen.findByRole('combobox', { name: 'État' })
    await userEvent.selectOptions(state, 'response_received')
    expect(screen.getByText('Les messages non envoyés seront annulés.')).toBeInTheDocument()
    expect(screen.getByText('Aucune semaine planifiée')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Enregistrer le suivi' }))
    const dialog = await screen.findByRole('dialog', { name: 'Passer à « Réponse reçue » ?' })
    expect(dialog).toHaveTextContent('La prochaine semaine (S40 2026) sera retirée.')
    await userEvent.click(within(dialog).getByRole('button', { name: 'Confirmer « Réponse reçue »' }))
    await waitFor(() => {
      expect(announced()).toContain('Suivi enregistré.')
    })
    const patch = api.prospects.requests.filter((request) => request.method === 'PATCH').at(-1)
    expect(patch?.body).toEqual({ status: 'response_received', version: detail.version })
  })

  it('plans a week without changing the state, and needs no confirmation', async () => {
    const detail = person()
    const { api } = open(detail)
    await userEvent.click(await screen.findByRole('button', { name: '+1 semaine' }))
    await userEvent.click(screen.getByRole('button', { name: 'Enregistrer le suivi' }))
    await waitFor(() => {
      expect(announced()).toContain('Suivi enregistré.')
    })
    const patch = api.prospects.requests.filter((request) => request.method === 'PATCH').at(-1)
    expect(patch?.body).toEqual({ next_action_week: { year: 2026, week: 41 }, version: detail.version })
  })
})
