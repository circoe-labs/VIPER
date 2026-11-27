import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'

import type { Message, MessageStep } from '../api/contact'
import type { Prospect } from '../api/prospects'
import { contactDashboard, message, sent, stubContactApi, version } from '../test/contactApi'
import { prospectDetail, trackingDetail } from '../test/prospectsApi'
import { renderApp } from '../test/render'
import { AUTOSAVE_DELAY_MS } from './MailEditor'

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
    defaults: { from_email: 'prospection@exemple.example', to: ['claire@exemple.example'], generation_available: false, toolbox_connected: false, toolbox_state: 'disabled' as const, automatic_sending_active: false, dispatch_reason: 'toolbox_disabled' as const, dispatch_max_lateness_minutes: 360, dispatch_claim_ttl_seconds: 600 },
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

// The recipients sit behind one line of the toolbar: it opens them (De, À, Cc, Cci) in a popover.
async function recipients() {
  const button = await screen.findByRole('button', { name: /^Destinataires/ })
  if (button.getAttribute('aria-expanded') !== 'true') await userEvent.click(button)
}

// The status, the notices and the warnings are icons of the toolbar: the icon's name is the sentence.
function icon(name: string | RegExp) {
  return screen.getByRole('button', { name })
}

// An icon of the toolbar opens its detail in a popover.
async function openIcon(name: string | RegExp) {
  await userEvent.click(await screen.findByRole('button', { name }))
  return screen.findByRole('dialog')
}

// The rarely used actions (cancel, delete) sit behind the « … » button of the action row.
async function moreActions() {
  await userEvent.click(await screen.findByRole('button', { name: 'Plus d’actions' }))
  return screen.findByRole('menu', { name: 'Plus d’actions' })
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

  it('starts an empty step from the defaults and creates the draft by itself (never validated)', async () => {
    const detail = person()
    const { api } = open(detail)
    expect(await screen.findByRole('tab', { name: /^Contact/ })).toHaveAttribute('aria-selected', 'true')
    expect(tab('Contact')).toHaveTextContent('Vide')
    await recipients()
    expect(field('De')).toHaveValue('prospection@exemple.example')
    expect(field('À')).toHaveValue('claire@exemple.example')
    expect(screen.queryByRole('button', { name: 'Valider…' })).not.toBeInTheDocument()
    // No « Enregistrer » nor « Créer le brouillon »: the draft takes what is typed.
    expect(screen.queryByRole('button', { name: 'Enregistrer' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Créer le brouillon' })).not.toBeInTheDocument()

    await userEvent.type(field('Objet'), 'Bonjour')
    // Leaving the field saves at once (else the draft saves itself 1.5 s after the last key): the draft is created.
    await userEvent.tab()
    await waitFor(() => {
      expect(tab('Contact')).toHaveTextContent('Brouillon')
    })
    await waitFor(() => {
      expect(announced()).toContain('Brouillon Contact créé.')
    })
    const [created] = sent(api.requests, 'PUT', `/api/prospects/${detail.id}/messages/contact`)
    expect(created?.body).toEqual({
      from_email: 'prospection@exemple.example',
      subject: 'Bonjour',
      body_text: '',
      to: ['claire@exemple.example'],
      cc: [],
      bcc: [],
    })

    await userEvent.type(field('Corps'), 'Un message de test.')
    await userEvent.tab()
    await waitFor(() => {
      expect(sent(api.requests, 'PUT', `/api/prospects/${detail.id}/messages/contact`)).toHaveLength(2)
    })
    expect(sent(api.requests, 'PUT', `/api/prospects/${detail.id}/messages/contact`)[1]?.body).toMatchObject({
      expected_revision: 1,
      body_text: 'Un message de test.',
    })
    expect(sent(api.requests, 'POST', `/api/prospects/${detail.id}/messages/contact/validate`)).toHaveLength(0)
  })

  it('saves what is typed by itself after a pause, and says so with a discreet icon', async () => {
    const detail = person()
    const { api } = open(detail, { contact: message('contact', 'draft', { prospect_id: detail.id }) })
    await userEvent.type(await screen.findByRole('textbox', { name: 'Objet' }), ' modifié')
    expect(icon(/Modifications en cours d’enregistrement automatique/)).toBeInTheDocument()
    expect(sent(api.requests, 'PUT', `/api/prospects/${detail.id}/messages/contact`)).toHaveLength(0)
    await waitFor(
      () => {
        expect(icon(/^Enregistré à /)).toBeInTheDocument()
      },
      { timeout: 4000 },
    )
    const [put] = sent(api.requests, 'PUT', `/api/prospects/${detail.id}/messages/contact`)
    expect(put?.body).toMatchObject({ expected_revision: 1, subject: 'Objet contact modifié' })
    expect(field('Objet')).toHaveValue('Objet contact modifié')
  })

  it('offers no review verdict any more (no « Correct » / « À revoir », no « Enregistrer »)', async () => {
    const detail = person()
    open(detail, { contact: message('contact', 'scheduled', { prospect_id: detail.id }) })
    await screen.findByRole('tab', { name: /Contact/ })
    expect(screen.queryByRole('group', { name: 'Avis sur le texte' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Correct' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'À revoir' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Enregistrer' })).not.toBeInTheDocument()
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
    // « Valider… » is gone: the focus lands on the status icon, which reads the new status.
    await waitFor(() => {
      expect(icon(/prêt à être programmé/)).toHaveFocus()
    })

    // No default time: « Programmer… » opens the send moment; without a date and time it says what is missing.
    await userEvent.click(screen.getByRole('button', { name: 'Programmer…' }))
    await userEvent.click(screen.getByRole('button', { name: 'Programmer l’envoi…' }))
    expect(screen.getByRole('alert')).toHaveTextContent('Choisissez la date et l’heure d’envoi.')
    const tomorrow = new Date(Date.now() + 86_400_000)
    const day = `${String(tomorrow.getFullYear())}-${String(tomorrow.getMonth() + 1).padStart(2, '0')}-${String(tomorrow.getDate()).padStart(2, '0')}`
    await userEvent.type(screen.getByLabelText('Date d’envoi'), day)
    await userEvent.type(screen.getByLabelText('Heure'), '09:30')
    // The typed moment survives a tab switch.
    await userEvent.click(tab('R1'))
    await userEvent.click(tab('Contact'))
    await userEvent.click(screen.getByRole('button', { name: 'Programmer…' }))
    expect(screen.getByLabelText('Date d’envoi')).toHaveValue(day)
    expect(screen.getByLabelText('Heure')).toHaveValue('09:30')
    await userEvent.click(screen.getByRole('button', { name: 'Programmer l’envoi…' }))
    // Automatic sending inactive (S9): scheduling stays possible, « quand même ».
    await confirmDialog(/Programmer le message Contact/, 'Programmer quand même')
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

  it('validates and schedules in one confirmation once a date and time are typed on a draft', async () => {
    const detail = person()
    const { api } = open(detail, { contact: message('contact', 'draft', { prospect_id: detail.id }) })
    // Without a date: the plain « Valider… ».
    expect(await screen.findByRole('button', { name: 'Valider…' })).toBeInTheDocument()
    // The send moment is optional on a draft: the calendar icon opens it.
    await userEvent.click(screen.getByRole('button', { name: 'Programmer l’envoi (facultatif)' }))
    const tomorrow = new Date(Date.now() + 86_400_000)
    const day = `${String(tomorrow.getFullYear())}-${String(tomorrow.getMonth() + 1).padStart(2, '0')}-${String(tomorrow.getDate()).padStart(2, '0')}`
    await userEvent.type(screen.getByLabelText('Date d’envoi'), day)
    // A date alone is not enough: the time is asked for before anything is validated.
    await userEvent.click(screen.getByRole('button', { name: 'Valider et programmer…' }))
    expect(screen.getByRole('alert')).toHaveTextContent('Choisissez l’heure d’envoi')
    expect(sent(api.requests, 'POST', `/api/prospects/${detail.id}/messages/contact/validate`)).toHaveLength(0)

    await userEvent.type(screen.getByLabelText('Heure'), '09:30')
    await userEvent.click(screen.getByRole('button', { name: 'Valider et programmer…' }))
    await confirmDialog(/Valider et programmer le message Contact/, 'Valider et programmer quand même')
    await waitFor(() => {
      expect(tab('Contact')).toHaveTextContent('Programmé')
    })
    expect(sent(api.requests, 'POST', `/api/prospects/${detail.id}/messages/contact/validate`)).toHaveLength(1)
    const [schedule] = sent(api.requests, 'POST', `/api/prospects/${detail.id}/messages/contact/schedule`)
    const body = schedule?.body as { expected_revision: number; scheduled_at: string }
    expect(body.scheduled_at).toMatch(new RegExp(`^${day}T09:30:00[+-]\\d{2}:\\d{2}$`))
    expect(announced()).toContain('validé et programmé pour le')
  })

  it('deletes a draft after a confirmation, but offers no deletion once it is validated', async () => {
    const detail = person()
    const { api } = open(detail, { contact: message('contact', 'draft', { prospect_id: detail.id }) })
    await moreActions()
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Supprimer le brouillon…' }))
    const dialog = await screen.findByRole('dialog', { name: /Supprimer le brouillon Contact/ })
    expect(dialog).toHaveTextContent('rien ne part')
    await userEvent.click(within(dialog).getByRole('button', { name: 'Supprimer le brouillon' }))
    await waitFor(() => {
      expect(sent(api.requests, 'POST', `/api/prospects/${detail.id}/messages/contact/delete`)).toHaveLength(1)
    })
    await waitFor(() => {
      expect(screen.queryByRole('button', { name: 'Plus d’actions' })).not.toBeInTheDocument()
    })
    expect(announced()).toContain('Brouillon Contact supprimé')
  })

  it('does not offer to delete a validated message, only to cancel it', async () => {
    const detail = person()
    open(detail, { contact: message('contact', 'validated', { prospect_id: detail.id }) })
    await moreActions()
    expect(await screen.findByRole('menuitem', { name: 'Annuler le message…' })).toBeInTheDocument()
    expect(screen.queryByRole('menuitem', { name: 'Supprimer le brouillon…' })).not.toBeInTheDocument()
  })

  it('« Valider » takes the typed text with it: saved, then validated, after one confirmation', async () => {
    const detail = person()
    const { api } = open(detail, { contact: message('contact', 'draft', { prospect_id: detail.id }) })
    await userEvent.type(await screen.findByRole('textbox', { name: 'Objet' }), ' modifié')
    expect(screen.queryByRole('button', { name: 'Enregistrer et valider…' })).not.toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Valider…' }))
    const dialog = await screen.findByRole('dialog', { name: /Valider le message Contact/ })
    expect(dialog).toHaveTextContent('Rien n’est envoyé maintenant')
    await userEvent.click(within(dialog).getByRole('button', { name: 'Valider le message' }))
    await waitFor(() => {
      expect(tab('Contact')).toHaveTextContent('Validé')
    })
    const [put] = sent(api.requests, 'PUT', `/api/prospects/${detail.id}/messages/contact`)
    expect(put?.body).toMatchObject({ subject: 'Objet contact modifié' })
    const [validate] = sent(api.requests, 'POST', `/api/prospects/${detail.id}/messages/contact/validate`)
    expect(validate?.body).toEqual({ expected_revision: 2 })
  })

  it('edits a scheduled message without asking, and says at once and after the save that it is no longer scheduled', async () => {
    const detail = person()
    const { api } = open(detail, { contact: message('contact', 'scheduled', { prospect_id: detail.id }) })
    await userEvent.type(await screen.findByRole('textbox', { name: 'Objet' }), 'X')
    expect(screen.queryByRole('dialog', { name: /Modifier le message/ })).not.toBeInTheDocument()
    expect(field('Objet')).toHaveValue('Objet contactX')
    // Before the save: what it will take away, with the send date.
    expect(screen.getByText(/une fois enregistrée, ce message ne sera plus programmé \(envoi prévu le .*2026.*\)/)).toBeInTheDocument()
    await userEvent.tab()
    await waitFor(() => {
      expect(tab('Contact')).toHaveTextContent('Brouillon')
    })
    expect(announced()).toContain('repassé en Brouillon : à revalider')
    expect(screen.getByText(/Validation retirée par la modification|Plus programmé : la modification a retiré/)).toBeInTheDocument()
    const [put] = sent(api.requests, 'PUT', `/api/prospects/${detail.id}/messages/contact`)
    expect(put?.body).toMatchObject({ expected_revision: 1, subject: 'Objet contactX' })
    // Validating again is still required, and ends the sentence.
    await userEvent.click(screen.getByRole('button', { name: 'Valider…' }))
    await confirmDialog(/Valider le message Contact/, 'Valider le message')
    await waitFor(() => {
      expect(tab('Contact')).toHaveTextContent('Validé')
    })
    expect(screen.queryByText(/Validation retirée par la modification/)).not.toBeInTheDocument()
  })

  it('says the lost send date the server kept, until the message is scheduled again', async () => {
    const detail = person()
    open(detail, {
      contact: message('contact', 'draft', {
        prospect_id: detail.id,
        missed_scheduled_at: '2026-10-06T07:30:00Z',
        missed_reason: 'edited',
        missed_at: '2026-09-30T08:00:00Z',
      }),
    })
    expect(await screen.findByText(/Plus programmé : la modification a retiré l’envoi prévu le .*2026.*revalidez-le puis reprogrammez-le/)).toBeInTheDocument()
  })

  it('never takes a schedule away by opening, focusing or typing back to the saved text', async () => {
    const detail = person()
    const { api } = open(detail, {
      contact: message('contact', 'scheduled', { prospect_id: detail.id }),
      r1: message('r1', 'validated', { prospect_id: detail.id }),
    })
    await userEvent.click(await screen.findByRole('textbox', { name: 'Objet' }))
    await userEvent.click(field('Corps'))
    await userEvent.tab()
    await userEvent.type(field('Objet'), 'X{Backspace}')
    await userEvent.click(screen.getByRole('tab', { name: /^R1/ }))
    await userEvent.click(await screen.findByRole('tab', { name: /^Contact/ }))
    await new Promise((resolve) => window.setTimeout(resolve, AUTOSAVE_DELAY_MS + 200))
    expect(api.requests.filter((request) => request.method !== 'GET')).toHaveLength(0)
    expect(tab('Contact')).toHaveTextContent('Programmé')
    expect(screen.queryByText(/Modification en cours/)).not.toBeInTheDocument()
  })

  it('shows an old R3 kept in the history as read-only: nothing to write, validate or schedule', async () => {
    const detail = person()
    open(detail, {
      r3: message('r3', 'cancelled', { prospect_id: detail.id, cancel_reason: 'sequence_limit' }),
    })
    await userEvent.click(await screen.findByRole('tab', { name: /^R3/ }))
    expect(await screen.findByRole('textbox', { name: 'Objet' })).toHaveAttribute('readonly')
    expect(icon(/^Annulé le .*trois e-mails au plus/)).toBeInTheDocument()
    for (const name of ['Rouvrir', 'Valider…', 'Programmer…']) {
      expect(screen.queryByRole('button', { name })).not.toBeInTheDocument()
    }
  })

  it('warns, without blocking, when R1 is scheduled before Contact has left', async () => {
    const detail = person()
    open(detail, {
      contact: message('contact', 'validated', { prospect_id: detail.id }),
      r1: message('r1', 'validated', { prospect_id: detail.id }),
    })
    await userEvent.click(await screen.findByRole('tab', { name: /^R1/ }))
    await userEvent.click(await screen.findByRole('button', { name: 'Programmer…' }))
    expect(screen.getByText('Le message Contact est « Validé » : vérifiez que R1 ne partira pas avant lui.')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Programmer…' })).toBeEnabled()
  })

  it('cancels after a confirmation and reopens as a draft', async () => {
    const detail = person()
    open(detail, { contact: message('contact', 'validated', { prospect_id: detail.id }) })
    await moreActions()
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Annuler le message…' }))
    await confirmDialog(/Annuler le message Contact/, 'Annuler le message')
    await waitFor(() => {
      expect(tab('Contact')).toHaveTextContent('Annulé')
    })
    await waitFor(() => {
      expect(icon(/^Annulé le/)).toHaveFocus()
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
    expect(
      await screen.findByRole('button', { name: 'Message envoyé : il reste consultable mais ne peut plus être modifié.' }),
    ).toBeInTheDocument()
    await recipients()
    for (const name of ['De', 'À', 'Objet', 'Corps']) expect(field(name)).toHaveAttribute('readonly')
    for (const name of ['Enregistrer', 'Valider…', 'Plus d’actions', 'Rouvrir']) {
      expect(screen.queryByRole('button', { name })).not.toBeInTheDocument()
    }
  })

  it('locks the editor of a closed sequence and of an opposition, and says why', async () => {
    const closed = person({ tracking: trackingDetail({ status: 'appointment_obtained' }) })
    open(closed, { contact: message('contact', 'scheduled', { prospect_id: closed.id }) })
    expect(await screen.findByRole('button', { name: /Séquence close par l’état « RDV pris »/ })).toBeInTheDocument()
    expect(field('Objet')).toHaveAttribute('readonly')
    expect(screen.getByRole('button', { name: 'Déprogrammer' })).toBeEnabled()
    expect(screen.queryByRole('button', { name: 'Enregistrer' })).not.toBeInTheDocument()
  })

  it('locks the editor of a person in opposition', async () => {
    const blocked = person({ contactability_status: 'do_not_contact', do_not_contact_reason: 'Demande écrite' })
    open(blocked)
    expect(await screen.findByRole('button', { name: /Prospect en opposition/ })).toBeInTheDocument()
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
    await userEvent.tab()
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

  it('keeps what is typed when the tab is left: the draft saves itself, nothing is lost', async () => {
    const detail = person()
    const { api, router } = open(detail)
    await userEvent.type(await screen.findByRole('textbox', { name: 'Objet' }), 'Non perdu')
    await userEvent.click(tab('R1'))
    await waitFor(() => {
      expect(tab('Contact')).toHaveTextContent('Brouillon')
    })
    await userEvent.click(tab('Contact'))
    expect(field('Objet')).toHaveValue('Non perdu')
    expect(sent(api.requests, 'PUT', `/api/prospects/${detail.id}/messages/contact`)).toHaveLength(1)

    // A mail never blocks leaving the prospect either.
    await userEvent.type(field('Objet'), ' encore')
    await userEvent.click(screen.getByRole('button', { name: 'Retour à la liste' }))
    await waitFor(() => {
      expect(router.state.location.search).toBe('')
    })
  })

  it('confirms a sequence-closing state, then patches the state alone (the next due date is derived)', async () => {
    const detail = person()
    const { api } = open(detail)
    const state = await screen.findByRole('combobox', { name: 'État commercial' })
    // « Défaillant » has its own confirmed action (Séquence de contact), it is not offered here.
    expect(within(state).queryByRole('option', { name: 'Défaillant' })).not.toBeInTheDocument()
    await userEvent.selectOptions(state, 'response_received')
    expect(screen.getByText('Les messages non envoyés seront annulés.')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Enregistrer le suivi' }))
    const dialog = await screen.findByRole('dialog', { name: 'Passer à « Réponse reçue » ?' })
    expect(dialog).not.toHaveTextContent('semaine')
    await userEvent.click(within(dialog).getByRole('button', { name: 'Confirmer « Réponse reçue »' }))
    await waitFor(() => {
      expect(announced()).toContain('Suivi enregistré.')
    })
    const patch = api.prospects.requests.filter((request) => request.method === 'PATCH').at(-1)
    expect(patch?.body).toEqual({ status: 'response_received', version: detail.version })
  })

  it('offers no week planner, and resumes the sequence without a confirmation', async () => {
    const detail = person({ tracking: trackingDetail({ status: 'response_received' }) })
    const { api } = open(detail)
    const state = await screen.findByRole('combobox', { name: 'État commercial' })
    expect(screen.queryByRole('button', { name: '+1 semaine' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Enregistrer le suivi' })).toBeDisabled()
    await userEvent.selectOptions(state, 'neutral')
    expect(screen.getByText('La séquence reprend là où elle s’était arrêtée (le niveau est conservé).')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Enregistrer le suivi' }))
    await waitFor(() => {
      expect(announced()).toContain('Suivi enregistré.')
    })
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    const patch = api.prospects.requests.filter((request) => request.method === 'PATCH').at(-1)
    expect(patch?.body).toEqual({ status: 'neutral', version: detail.version })
  })

  describe('with the CIRCOE Toolbox connected (S6)', () => {
    const connected = {
      defaults: {
        from_email: 'prospection@exemple.example',
        to: ['claire@exemple.example'],
        generation_available: false,
        toolbox_connected: true,
        toolbox_state: 'connected' as const,
        automatic_sending_active: false,
        dispatch_reason: 'disabled' as const,
        dispatch_max_lateness_minutes: 360,
        dispatch_claim_ttl_seconds: 600,
      },
    }

    it('says the real sender, then that the validation created the Infomaniak draft', async () => {
      const detail = person()
      open(detail, { contact: message('contact', 'draft', { prospect_id: detail.id }) }, connected)
      await recipients()
      expect(await screen.findByText(/boîte Infomaniak par défaut du compte connecté/)).toBeInTheDocument()

      await userEvent.click(await screen.findByRole('button', { name: 'Valider…' }))
      await confirmDialog(/Valider le message Contact/, 'Valider le message')

      expect(await screen.findByRole('button', { name: 'Brouillon créé dans Infomaniak.' })).toBeInTheDocument()
      expect(screen.getAllByText(/validé et brouillon créé dans Infomaniak/).length).toBeGreaterThan(0)
    })

    it('says a failed draft and creates it again on « Réessayer »', async () => {
      const detail = person()
      const { api } = open(
        detail,
        { contact: message('contact', 'draft', { prospect_id: detail.id }) },
        { ...connected, remoteDraftFailure: 'toolbox_unavailable' },
      )
      await userEvent.click(await screen.findByRole('button', { name: 'Valider…' }))
      await confirmDialog(/Valider le message Contact/, 'Valider le message')

      const draft = await openIcon('Brouillon Infomaniak non créé : la Toolbox ne répond pas.')
      // The outcome, in the live region: validated, but the draft is missing.
      expect(screen.getAllByText(/validé, mais le brouillon Infomaniak n’a pas été créé : la Toolbox ne répond pas/).length).toBeGreaterThan(0)
      // The validation stands.
      expect(tab('Contact')).toHaveTextContent('Validé')
      await userEvent.click(within(draft).getByRole('button', { name: 'Réessayer' }))

      expect(await screen.findByRole('button', { name: 'Brouillon créé dans Infomaniak.' })).toBeInTheDocument()
      expect(sent(api.requests, 'POST', `/api/prospects/${detail.id}/messages/contact/remote-draft`)).toHaveLength(1)
    })

    it('says the draft is not created while the Toolbox is enabled but to reconnect', async () => {
      const detail = person()
      open(
        detail,
        { contact: message('contact', 'validated', { prospect_id: detail.id }) },
        { defaults: { ...connected.defaults, toolbox_connected: false, toolbox_state: 'expired' as const } },
      )
      const draft = await openIcon('Brouillon Infomaniak non créé : Toolbox à reconnecter.')
      expect(within(draft).queryByRole('button', { name: 'Réessayer' })).not.toBeInTheDocument()
    })

    it('says nothing about Infomaniak while the Toolbox is off', async () => {
      const detail = person()
      open(detail, { contact: message('contact', 'validated', { prospect_id: detail.id }) })
      expect(await screen.findByRole('button', { name: /prêt à être programmé/ })).toBeInTheDocument()
      expect(screen.queryByText(/Infomaniak/)).not.toBeInTheDocument()
      expect(screen.queryByRole('button', { name: /Infomaniak/ })).not.toBeInTheDocument()
    })
  })
  describe('scheduled sending (S7)', () => {
    const active = {
      defaults: {
        from_email: 'prospection@exemple.example',
        to: ['claire@exemple.example'],
        generation_available: false,
        toolbox_connected: true,
        toolbox_state: 'connected' as const,
        automatic_sending_active: true,
        dispatch_reason: null,
        dispatch_max_lateness_minutes: 360,
        dispatch_claim_ttl_seconds: 600,
      },
    }

    async function scheduleTomorrow() {
      const tomorrow = new Date(Date.now() + 86_400_000)
      const day = `${String(tomorrow.getFullYear())}-${String(tomorrow.getMonth() + 1).padStart(2, '0')}-${String(tomorrow.getDate()).padStart(2, '0')}`
      // « Programmer… » opens the send moment (once): date and time, then the confirm button of the popover.
      if (!screen.queryByLabelText('Date d’envoi')) await userEvent.click(await screen.findByRole('button', { name: 'Programmer…' }))
      await userEvent.type(await screen.findByLabelText('Date d’envoi'), day)
      await userEvent.type(screen.getByLabelText('Heure'), '09:30')
      await userEvent.click(screen.getByRole('button', { name: 'Programmer l’envoi…' }))
      return screen.findByRole('dialog', { name: /Programmer le message Contact/ })
    }

    it('promises an automatic send only when the server really sends', async () => {
      const detail = person()
      open(detail, { contact: message('contact', 'validated', { prospect_id: detail.id, has_remote_draft: true }) }, active)
      const dialog = await scheduleTomorrow()
      expect(dialog).toHaveTextContent('Le mail partira automatiquement à cette date depuis la boîte Infomaniak connectée')
      expect(dialog).toHaveTextContent('S’il ne peut pas partir dans les 6 heures qui suivent')
      await userEvent.click(within(dialog).getByRole('button', { name: 'Programmer l’envoi' }))
      expect(
        await screen.findByRole('button', { name: /^Programmé : le mail partira automatiquement le .* déprogrammable jusqu’à l’envoi\.$/ }),
      ).toBeInTheDocument()
    })

    it('says plainly that nothing leaves while automatic sending is off, with the link that fixes it (S9)', async () => {
      const detail = person()
      open(detail, { contact: message('contact', 'validated', { prospect_id: detail.id }) })
      // Before confirming: the warning and its link under the date and time, in the send moment's popover.
      await userEvent.click(await screen.findByRole('button', { name: 'Programmer…' }))
      const schedule = await screen.findByRole('group', { name: 'Programmer l’envoi' })
      expect(await within(schedule).findByText(/Envoi automatique inactif : CIRCOE Toolbox n’est pas connectée/)).toBeInTheDocument()
      expect(within(schedule).getByRole('link', { name: 'Connecter CIRCOE Toolbox' })).toHaveAttribute('href', '/settings/connections')
      const dialog = await scheduleTomorrow()
      expect(dialog).toHaveTextContent('Envoi automatique inactif : CIRCOE Toolbox n’est pas connectée')
      expect(within(dialog).getByRole('link', { name: 'Connecter CIRCOE Toolbox' })).toHaveAttribute('href', '/settings/connections')
      await userEvent.click(within(dialog).getByRole('button', { name: 'Programmer quand même' }))
      expect(await screen.findByRole('button', { name: 'Ne partira pas : Toolbox non connectée' })).toBeInTheDocument()
      expect(screen.getByRole('button', { name: /^Programmé pour le / })).toBeInTheDocument()
    })

    it('warns that a scheduled message will not leave when the person switched sending off (S9)', async () => {
      const detail = person()
      const past = new Date(Date.now() - 3_600_000).toISOString()
      open(detail, { contact: message('contact', 'scheduled', { prospect_id: detail.id, scheduled_at: past }) }, { defaults: { ...active.defaults, automatic_sending_active: false, dispatch_reason: 'disabled' } })
      await openIcon('Ne partira pas : envoi automatique désactivé')
      expect(screen.getByText(/L’heure prévue est passée : s’il ne peut pas partir dans les 6 heures/)).toBeInTheDocument()
      expect(screen.getByRole('link', { name: 'Activer l’envoi automatique' })).toHaveAttribute('href', '/settings/connections')
    })

    it('explains an overdue message went back to Validé and offers to schedule it again (S9)', async () => {
      const detail = person()
      open(detail, { contact: message('contact', 'validated', { prospect_id: detail.id, last_error_code: 'dispatch_overdue' }) }, active)
      await openIcon(/^Pas envoyé : l’heure prévue était dépassée de plus de 6 heures/)
      expect(screen.getByText(/VIPER n’envoie jamais un mail en retard/)).toBeInTheDocument()
      await userEvent.click(screen.getByRole('button', { name: 'Programmer…' }))
      expect(await screen.findByRole('group', { name: 'Programmer l’envoi' })).toBeInTheDocument()
    })

    it('locks a message being sent', async () => {
      const detail = person()
      open(detail, { contact: message('contact', 'scheduled', { prospect_id: detail.id, dispatch_claimed_at: new Date().toISOString() }) }, active)
      expect(await screen.findByText('Envoi en cours par la Toolbox…')).toBeInTheDocument()
      expect(screen.queryByRole('button', { name: 'Déprogrammer' })).not.toBeInTheDocument()
      expect(screen.queryByRole('button', { name: /Marquer envoyé/ })).not.toBeInTheDocument()
      expect(field('Objet')).toHaveAttribute('readonly')
    })

    it('lets a person settle an unconfirmed send, after a confirmation', async () => {
      const detail = person()
      const unconfirmed = message('contact', 'scheduled', {
        prospect_id: detail.id,
        // Claimed 11 minutes ago: past the delay, « Remettre en Validé » is open.
        dispatch_claimed_at: new Date(Date.now() - 11 * 60_000).toISOString(),
        last_error_code: 'send_outcome_unknown',
        has_remote_draft: true,
      })
      const { api } = open(detail, { contact: unconfirmed, r1: message('r1', 'scheduled', { prospect_id: detail.id, dispatch_claimed_at: new Date().toISOString(), last_error_code: 'send_reconcile_inconclusive' }) }, active)
      await openIcon('Envoi non confirmé : à trancher')
      expect(screen.getByText(/^Envoi non confirmé : la Toolbox n’a pas donné de réponse sûre/)).toBeInTheDocument()

      await userEvent.click(screen.getByRole('button', { name: 'Remettre en Validé…' }))
      const dialog = await screen.findByRole('dialog', { name: /Remettre le message Contact en Validé/ })
      expect(dialog).toHaveTextContent('le reprogrammer l’enverrait une seconde fois')
      expect(within(dialog).getByRole('button', { name: 'Retour' })).toHaveFocus()
      await userEvent.click(within(dialog).getByRole('button', { name: 'Remettre en Validé' }))
      await waitFor(() => {
        expect(tab('Contact')).toHaveTextContent('Validé')
      })
      expect(screen.getByRole('button', { name: /^Remis en Validé par une personne après un envoi non confirmé/ })).toBeInTheDocument()
      expect(sent(api.requests, 'POST', `/api/prospects/${detail.id}/messages/contact/release`)).toHaveLength(1)

      await userEvent.click(tab('R1'))
      await userEvent.click(await screen.findByRole('button', { name: 'Marquer envoyé…' }))
      await confirmDialog(/Marquer le message R1 comme envoyé/, 'Marquer envoyé')
      await waitFor(() => {
        expect(tab('R1')).toHaveTextContent('Envoyé')
      })
      expect(
        screen.getByRole('button', { name: 'Envoi confirmé par une personne après vérification dans la boîte Infomaniak.' }),
      ).toBeInTheDocument()
    })

    it('waits for the claim’s delay before « Remettre en Validé », and hides the draft line meanwhile', async () => {
      const detail = person()
      open(
        detail,
        {
          contact: message('contact', 'scheduled', {
            prospect_id: detail.id,
            dispatch_claimed_at: new Date().toISOString(),
            last_error_code: 'send_outcome_unknown',
            has_remote_draft: true,
          }),
        },
        active,
      )
      expect(await screen.findByRole('button', { name: 'Remettre en Validé…' })).toBeDisabled()
      expect(screen.getByRole('button', { name: 'Marquer envoyé…' })).toBeEnabled()
      await openIcon('Envoi non confirmé : à trancher')
      expect(screen.getByText(/^« Remettre en Validé » possible à partir de /)).toBeInTheDocument()
      expect(screen.queryByRole('button', { name: 'Brouillon créé dans Infomaniak.' })).not.toBeInTheDocument()
    })

    it('says a deduced send', async () => {
      const detail = person()
      open(detail, { contact: message('contact', 'sent', { prospect_id: detail.id, last_error_code: 'send_reconciled_draft_absent' }) }, active)
      expect(await screen.findByRole('button', { name: /^Envoi déduit : la Toolbox n’a pas confirmé l’envoi/ })).toBeInTheDocument()
      expect(screen.getByRole('button', { name: /^Envoyé le / })).toBeInTheDocument()
    })
  })
})

describe('Versions, saved mails, the fiche overlay and the default sender', () => {
  const kept = (id: string, step: MessageStep = 'contact') => `${id}:${step}`

  it('lists the kept versions with their count, compares one with the text shown and restores it', async () => {
    const detail = person()
    const older = version('contact', 'ai', { id: 'v-old', subject: 'Objet IA ancien', body_text: 'Bonjour,\nAncien corps.\nMerci', config: { tone: 2, sender: 'ai', model: 'fake-model' } })
    const current = version('contact', 'manual', { id: 'v-now', subject: 'Objet contact', body_text: 'Bonjour,\nCorps contact\nMerci' })
    const { api } = open(
      detail,
      { contact: message('contact', 'draft', { prospect_id: detail.id, subject: 'Objet contact', body_text: 'Bonjour,\nCorps contact\nMerci' }) },
      { versions: { [kept(detail.id)]: [current, older] } },
    )
    await userEvent.click(await screen.findByRole('button', { name: 'Versions du message : 2' }))
    const popover = await screen.findByRole('dialog', { name: 'Versions du message Contact' })
    expect(within(popover).getAllByRole('listitem')).toHaveLength(2)
    expect(popover).toHaveTextContent('Objet IA ancien')
    expect(popover).toHaveTextContent('Ton 2 · expéditeur IA · fake-model')
    // The text shown now is the current version.
    expect(within(popover).getByText('Actuelle')).toBeInTheDocument()

    // The current version cannot be compared with itself; the older one can.
    await userEvent.click(within(popover).getAllByRole('button', { name: 'Comparer avec le texte actuel' })[1] as HTMLElement)
    const compare = await screen.findByRole('dialog', { name: 'Comparer les versions · Contact' })
    expect(compare).toHaveTextContent('Ancien corps.')
    expect(compare).toHaveTextContent('Corps contact')
    await userEvent.click(within(compare).getByRole('button', { name: 'Restaurer cette version' }))

    await waitFor(() => {
      expect(field('Objet')).toHaveValue('Objet IA ancien')
    })
    const [posted] = sent(api.requests, 'POST', `/api/prospects/${detail.id}/messages/contact/versions/v-old/restore`)
    expect(posted?.body).toEqual({ expected_revision: 1 })
    await waitFor(() => {
      expect(announced()).toContain('le texte précédent reste dans les versions')
    })
  })

  it('goes back to a version with one click on a draft, and asks first on a validated message', async () => {
    const detail = person()
    const older = version('contact', 'ai', { id: 'v-old', subject: 'Objet IA ancien' })
    const { api } = open(
      detail,
      { contact: message('contact', 'validated', { prospect_id: detail.id }) },
      { versions: { [kept(detail.id)]: [version('contact', 'manual', { id: 'v-now' }), older] } },
    )
    await userEvent.click(await screen.findByRole('button', { name: 'Versions du message : 2' }))
    await userEvent.click(within(await screen.findByRole('dialog', { name: 'Versions du message Contact' })).getByTitle(/Revenir à cette version/))
    const dialog = await screen.findByRole('dialog', { name: 'Revenir à cette version ?' })
    expect(dialog).toHaveTextContent('Le message est validé : il repassera en Brouillon')
    await userEvent.click(within(dialog).getByRole('button', { name: 'Revenir à cette version' }))
    await waitFor(() => {
      expect(tab('Contact')).toHaveTextContent('Brouillon')
    })
    expect(sent(api.requests, 'POST', `/api/prospects/${detail.id}/messages/contact/versions/v-old/restore`)).toHaveLength(1)
  })

  it('keeps a mail with a 0-10 note and a comment, and lists it in « Suivi de contact »', async () => {
    const detail = person()
    const { api } = open(detail, { contact: message('contact', 'draft', { prospect_id: detail.id, generation_model: 'fake-model' }) })
    await userEvent.click(await screen.findByRole('button', { name: 'Sauvegarder' }))
    const popover = await screen.findByRole('dialog', { name: 'Sauvegarder le message Contact' })
    // The ends of the scale are named; nothing is saved without a note.
    const scale = within(popover).getByRole('radiogroup', { name: 'Note de 0 à 10' })
    expect(within(scale).getAllByRole('radio')).toHaveLength(11)
    expect(within(scale).getByRole('radio', { name: '0' })).toHaveAttribute('title', 'Vraiment de la merde, ne fais plus jamais ça')
    expect(within(scale).getByRole('radio', { name: '10' })).toHaveAttribute('title', 'Super, garde ce style')
    const confirm = within(popover).getByRole('button', { name: 'Sauvegarder' })
    expect(confirm).toBeDisabled()
    await userEvent.click(within(scale).getByRole('radio', { name: '8' }))
    await userEvent.type(within(popover).getByRole('textbox', { name: /Commentaire/ }), 'Bon ton')
    await userEvent.click(confirm)

    await waitFor(() => {
      expect(sent(api.requests, 'POST', `/api/prospects/${detail.id}/messages/contact/saved`)).toHaveLength(1)
    })
    expect(sent(api.requests, 'POST', `/api/prospects/${detail.id}/messages/contact/saved`)[0]?.body).toEqual({ rating: 8, comment: 'Bon ton' })
    expect(announced()).toContain('sauvegardé avec la note 8/10')

    const entry = await screen.findByTitle('Bon ton')
    expect(entry).toHaveTextContent('Contact')
    expect(entry).toHaveTextContent('Objet contact')
    expect(entry).toHaveAttribute('title', 'Bon ton')
    await userEvent.click(entry)
    const full = await screen.findByRole('dialog', { name: 'Mail sauvegardé · Contact' })
    expect(full).toHaveTextContent('Bon ton')
    expect(full).toHaveTextContent('Corps contact')
    expect(full).toHaveTextContent('fake-model')
  })

  it('opens the whole fiche over the page from the avatar or the name, and Esc closes it', async () => {
    const detail = person()
    open(detail)
    const name = within(await screen.findByRole('heading', { level: 2 })).getByRole('button')
    expect(name).toHaveAttribute('title', 'Voir la fiche')
    expect(name).toHaveTextContent('Claire')
    expect(screen.getByRole('button', { name: /Voir la fiche de Claire Démo/ })).toHaveAttribute('title', 'Voir la fiche')
    await userEvent.click(name)
    const fiche = await screen.findByRole('dialog', { name: /Claire Démo/ })
    expect(fiche).toBeInTheDocument()
    // The workbench stays behind it.
    expect(screen.getByRole('tablist', { name: 'Étapes de la séquence' })).toBeInTheDocument()
    await userEvent.keyboard('{Escape}')
    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: /Claire Démo/ })).not.toBeInTheDocument()
    })
  })

  it('shows the default sender on a message created without one, and validates without asking for it', async () => {
    const detail = person()
    const { api } = open(detail, { contact: message('contact', 'draft', { prospect_id: detail.id, from_email: null }) })
    await screen.findByRole('tab', { name: /^Contact/ })
    await recipients()
    expect(field('De')).toHaveValue('prospection@exemple.example')
    await userEvent.keyboard('{Escape}')
    await userEvent.click(screen.getByRole('button', { name: 'Valider…' }))
    await confirmDialog(/Valider le message Contact/, 'Valider le message')
    await waitFor(() => {
      expect(tab('Contact')).toHaveTextContent('Validé')
    })
    expect(sent(api.requests, 'PUT', `/api/prospects/${detail.id}/messages/contact`)).toHaveLength(0)
  })
})
