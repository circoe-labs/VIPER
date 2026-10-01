import { act, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { Message, MessageStep } from '../api/contact'
import type { Prospect } from '../api/prospects'
import { contactDashboard, message, sent, stubContactApi } from '../test/contactApi'
import { prospectDetail, trackingDetail } from '../test/prospectsApi'
import { renderApp } from '../test/render'

// « Générer avec l'IA » in the Contact workbench against the Contact fake (S5): the button in the action bar's left
// slot, the « consigne », the confirmation before replacing a text, the running state, the result as a Brouillon and
// every failure said on screen.

function person(): Prospect {
  return prospectDetail({
    civility: 'ms',
    first_name: 'Claire',
    last_name: 'Démo',
    tracking: trackingDetail({ status: 'neutral', planned_contact_on: '2026-09-28', planned_contact_week: '2026-W40' }),
    today: '2026-09-30',
  })
}

function open(
  messages: Partial<Record<MessageStep, Message>> = {},
  extra: Parameters<typeof stubContactApi>[0] = {},
  available = true,
) {
  const detail = person()
  const api = stubContactApi({
    dashboard: contactDashboard(),
    details: [detail],
    messages: { [detail.id]: messages },
    defaults: { from_email: 'prospection@exemple.example', to: ['claire@exemple.example'], generation_available: available, toolbox_connected: false, toolbox_state: 'disabled' as const, automatic_sending_active: false, dispatch_max_lateness_minutes: 360, dispatch_claim_ttl_seconds: 600 },
    ...extra,
  })
  renderApp(`/contact?prospect=${detail.id}`)
  return { api, id: detail.id }
}

function actions() {
  return screen.getByRole('tabpanel')
}

function announced() {
  return screen.getAllByRole('status').map((status) => status.textContent).join(' ')
}

afterEach(() => {
  vi.useRealTimers()
})

describe('AI drafting in the mail editor', () => {
  it('generates an empty step at once: a Brouillon with the AI note, the model and prompt version as a hint', async () => {
    const { api, id } = open()
    const button = await screen.findByRole('button', { name: 'Générer avec l’IA' })
    expect(button).toHaveClass('btn--secondary')
    // In the action bar's left slot, beside the step's own actions.
    expect(button.closest('.contact-mail__assist')).not.toBeNull()

    await userEvent.click(button)

    await waitFor(() => {
      expect(screen.getByRole('textbox', { name: 'Objet' })).toHaveValue('Objet IA 1')
    })
    expect(screen.getByRole('textbox', { name: 'Corps' })).toHaveValue('Bonjour,\n\nCorps IA 1.')
    expect(screen.getByText('Rédigé par l’IA — à relire avant de valider.')).toBeInTheDocument()
    expect(screen.getByText('Modèle fake-model · prompt contact-mail-fr-2026-09-v1')).toBeInTheDocument()
    expect(announced()).toContain('Brouillon Contact rédigé par l’IA : relisez-le, corrigez-le si besoin, puis validez-le.')
    // The button that started it was disabled meanwhile: the draft's status sentence has the focus.
    await waitFor(() => {
      expect(screen.getByText('Brouillon : à relire puis valider. Il ne peut pas partir tel quel.')).toHaveFocus()
    })
    expect(screen.getByRole('button', { name: 'Régénérer avec l’IA' })).toBeEnabled()
    // Still to validate by hand.
    expect(screen.getByRole('button', { name: 'Valider…' })).toBeEnabled()
    const [request] = sent(api.requests, 'POST', `/api/prospects/${id}/messages/contact/generate`)
    expect(request?.body).toEqual({})
  })

  it('sends the « consigne » and asks before replacing a validated text, which goes back to Brouillon', async () => {
    const { api, id } = open({ contact: message('contact', 'validated', { revision: 2 }) })
    await userEvent.click(await screen.findByRole('button', { name: 'Consigne' }))
    expect(screen.getByRole('button', { name: 'Consigne' })).toHaveAttribute('aria-expanded', 'true')
    await userEvent.type(screen.getByRole('textbox', { name: 'Consigne pour l’IA (facultatif)' }), 'Plus court')

    await userEvent.click(screen.getByRole('button', { name: 'Régénérer avec l’IA' }))
    const dialog = await screen.findByRole('dialog', { name: 'Régénérer le message Contact ?' })
    expect(dialog).toHaveTextContent('L’objet et le corps enregistrés seront remplacés')
    expect(dialog).toHaveTextContent('Le message repassera en Brouillon')
    // « Retour » first: Enter never replaces by accident.
    expect(within(dialog).getByRole('button', { name: 'Retour' })).toHaveFocus()
    await userEvent.click(within(dialog).getByRole('button', { name: 'Remplacer par la proposition' }))

    await waitFor(() => {
      expect(screen.getByRole('textbox', { name: 'Objet' })).toHaveValue('Objet IA 1')
    })
    expect(sent(api.requests, 'POST', `/api/prospects/${id}/messages/contact/generate`)[0]?.body).toEqual({
      expected_revision: 2,
      instruction: 'Plus court',
      replace: true,
    })
    expect(announced()).toContain('Il est repassé en Brouillon : à revalider.')
    expect(within(screen.getByRole('tablist', { name: 'Étapes de la séquence' })).getByRole('tab', { name: /^Contact/ })).toHaveTextContent(
      'Brouillon',
    )
  })

  it('« Retour » keeps the text and sends nothing', async () => {
    const { api, id } = open({ contact: message('contact', 'draft') })
    await userEvent.click(await screen.findByRole('button', { name: 'Régénérer avec l’IA' }))
    const dialog = await screen.findByRole('dialog', { name: 'Régénérer le message Contact ?' })
    await userEvent.click(within(dialog).getByRole('button', { name: 'Retour' }))
    expect(screen.getByRole('textbox', { name: 'Objet' })).toHaveValue('Objet contact')
    expect(sent(api.requests, 'POST', `/api/prospects/${id}/messages/contact/generate`)).toHaveLength(0)
  })

  it('unsaved edits of an empty step are asked about, then replaced', async () => {
    open()
    await userEvent.type(await screen.findByRole('textbox', { name: 'Objet' }), 'Mon objet')
    await userEvent.click(screen.getByRole('button', { name: 'Générer avec l’IA' }))
    const dialog = await screen.findByRole('dialog', { name: 'Générer le message Contact ?' })
    expect(dialog).toHaveTextContent('Vos modifications non enregistrées seront perdues.')
    await userEvent.click(within(dialog).getByRole('button', { name: 'Générer avec l’IA' }))
    await waitFor(() => {
      expect(screen.getByRole('textbox', { name: 'Objet' })).toHaveValue('Objet IA 1')
    })
  })

  it('shows the running state with a live counter and locks the editor meanwhile', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    open({}, { generation: 'hang' })
    const user = userEvent.setup({ advanceTimers: (ms) => vi.advanceTimersByTime(ms) })
    await user.click(await screen.findByRole('button', { name: 'Générer avec l’IA' }))

    // Said once by the always-present live region, shown in the running block, which takes the focus from the
    // disabled button.
    await waitFor(() => {
      expect(announced()).toContain('L’IA rédige le message Contact…')
    })
    const running = actions().querySelector<HTMLElement>('.contact-ai__progress')
    expect(running).toHaveTextContent('L’IA rédige le message Contact…')
    await waitFor(() => {
      expect(running).toHaveFocus()
    })
    expect(screen.getByRole('button', { name: 'Générer avec l’IA' })).toBeDisabled()
    expect(screen.getByRole('textbox', { name: 'Objet' })).toHaveAttribute('readonly')
    act(() => {
      vi.advanceTimersByTime(3000)
    })
    expect(actions().querySelector('.contact-ai__elapsed')?.textContent).toMatch(/^[3-4] s$/)
    expect(screen.getByText(/Rien n’est modifié avant son arrivée/)).toBeInTheDocument()
  })

  it('keeps each step’s « consigne » across tab switches and says why the other tabs wait', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    open({}, { generation: 'hang' })
    const user = userEvent.setup({ advanceTimers: (ms) => vi.advanceTimersByTime(ms) })
    await user.click(await screen.findByRole('button', { name: 'Consigne' }))
    await user.type(screen.getByRole('textbox', { name: 'Consigne pour l’IA (facultatif)' }), 'Plus court')
    const tablist = screen.getByRole('tablist', { name: 'Étapes de la séquence' })
    await user.click(within(tablist).getByRole('tab', { name: /^R1/ }))
    expect(screen.queryByRole('textbox', { name: 'Consigne pour l’IA (facultatif)' })).toBeNull()
    await user.click(within(tablist).getByRole('tab', { name: /^Contact/ }))
    expect(screen.getByRole('textbox', { name: 'Consigne pour l’IA (facultatif)' })).toHaveValue('Plus court')

    await user.click(screen.getByRole('button', { name: 'Générer avec l’IA' }))
    await user.click(within(tablist).getByRole('tab', { name: /^R1/ }))
    expect(screen.getByRole('button', { name: 'Générer avec l’IA' })).toBeDisabled()
    expect(screen.getByText('L’IA rédige déjà le message Contact : attendez qu’elle ait fini pour générer celui-ci.')).toBeInTheDocument()
  })

  it('a rewrite of an AI text says the mention will go once saved', async () => {
    open({
      contact: message('contact', 'draft', { generation_model: 'fake-model', generation_prompt_version: 'contact-mail-fr-2026-09-v1' }),
    })
    expect(await screen.findByText('Rédigé par l’IA — à relire avant de valider.')).toBeInTheDocument()
    await userEvent.type(screen.getByRole('textbox', { name: 'Objet' }), ' (relu)')
    expect(screen.getByText('Rédigé par l’IA, modifié par vous : la mention disparaîtra à l’enregistrement.')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Enregistrer' }))
    await waitFor(() => {
      expect(screen.queryByText(/Rédigé par l’IA/)).toBeNull()
    })
  })

  it.each([
    [503, 'ai_not_configured', /pas configurée sur le serveur/],
    [504, 'ai_timeout', /pas répondu à temps/],
    [502, 'ai_invalid_output', /inutilisable/],
  ])('says a failure (%s %s) and keeps the saved text', async (status, code, text) => {
    open({ contact: message('contact', 'draft', { subject: '', body_text: '' }) }, { generation: { status, code } })
    await userEvent.click(await screen.findByRole('button', { name: 'Générer avec l’IA' }))
    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent(text)
    expect(alert).toHaveTextContent('Rien n’a été modifié')
    expect(screen.getByRole('button', { name: 'Générer avec l’IA' })).toBeEnabled()
  })

  it('is disabled with its reason when the server has no AI configured', async () => {
    open({}, {}, false)
    expect(await screen.findByRole('button', { name: 'Générer avec l’IA' })).toBeDisabled()
    expect(screen.getByText(/La rédaction par l’IA n’est pas configurée sur ce serveur/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Consigne' })).toBeNull()
  })

  it('is disabled on a scheduled message and absent on a sent one', async () => {
    open({ contact: message('contact', 'scheduled'), r1: message('r1', 'sent') })
    expect(await screen.findByRole('button', { name: 'Régénérer avec l’IA' })).toBeDisabled()
    expect(screen.getByText('Message programmé : déprogrammez-le avant de le régénérer.')).toBeInTheDocument()
    await userEvent.click(within(screen.getByRole('tablist', { name: 'Étapes de la séquence' })).getByRole('tab', { name: /^R1/ }))
    expect(screen.queryByRole('button', { name: /avec l’IA/ })).toBeNull()
  })
})
