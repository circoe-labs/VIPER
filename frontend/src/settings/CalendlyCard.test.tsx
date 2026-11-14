import { screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'

import { integrations, stubIntegrationsApi } from '../test/integrationsApi'
import { renderApp } from '../test/render'
import { stubSettingsApi } from '../test/settingsApi'
import { stubToolboxApi } from '../test/toolboxApi'

// Config AI › Calendly: the token (write-only), the booking link and the meetings read live.

const TOKEN = 'cal-jeton-synthetique-9876'
const SAVED = integrations(
  {},
  {
    calendly_api_token: { set: true, last4: '9876', source: 'ui', updated_at: '2026-10-23T08:00:00+00:00', updated_by: 'Pilote Test' },
  },
)

function stub(options: Parameters<typeof stubIntegrationsApi>[0] = {}) {
  stubSettingsApi({})
  stubToolboxApi()
  return stubIntegrationsApi(options)
}

const card = async () => screen.findByRole('region', { name: 'Connexion Calendly' })

describe('Calendly card', () => {
  it('saves the token, never shows it again, and can remove it', async () => {
    const api = stub()
    renderApp('/config-ai/calendly')

    const region = within(await card())
    expect(region.getByText('Non relié')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: /^Calendly/ })).toHaveAttribute('aria-current', 'page')
    expect(region.getByRole('button', { name: 'Enregistrer' })).toBeDisabled()
    expect(region.getByRole('button', { name: 'Tester' })).toBeDisabled()

    await userEvent.type(region.getByLabelText('Jeton d’accès personnel'), TOKEN)
    await userEvent.click(region.getByRole('button', { name: 'Enregistrer' }))

    expect(await region.findByText('Jeton enregistré : la synchronisation démarre.')).toBeInTheDocument()
    expect(api.puts.at(-1)).toMatchObject({ calendly_api_token: TOKEN })
    expect(screen.queryByDisplayValue(TOKEN)).not.toBeInTheDocument()
    expect(region.getByPlaceholderText('•••• 9876 (enregistré)')).toBeInTheDocument()

    await userEvent.click(region.getByRole('button', { name: 'Retirer' }))
    expect(await region.findByText('Jeton retiré : la synchronisation est arrêtée.')).toBeInTheDocument()
    expect(api.puts.at(-1)).toMatchObject({ calendly_api_token: null })
  })

  it('tests the saved token and says whose account it is', async () => {
    stub({ initial: SAVED })
    renderApp('/config-ai/calendly')

    const region = within(await card())
    await userEvent.click(region.getByRole('button', { name: 'Tester' }))

    expect(await region.findByText('Connecté')).toBeInTheDocument()
    expect(region.getByText('Compte Calendly : Hôte Circoe · hote@circoe.test')).toBeInTheDocument()
  })

  it('says in French why a token is refused', async () => {
    stub({ initial: SAVED, calendlyCheck: { ok: false, code: 'calendly_unauthorized', account: null, elapsed_ms: 100 } })
    renderApp('/config-ai/calendly')

    const region = within(await card())
    await userEvent.click(region.getByRole('button', { name: 'Tester' }))

    expect(await region.findByText(/Calendly refuse ce jeton/)).toBeInTheDocument()
  })

  it('moves the booking link here and saves it', async () => {
    const api = stub()
    renderApp('/config-ai/calendly')

    const booking = within(await screen.findByRole('region', { name: 'Lien de prise de rendez-vous' }))
    await userEvent.type(booking.getByRole('textbox', { name: 'Lien de réservation' }), 'https://calendly.com/circoe/30min')
    await userEvent.click(booking.getByRole('button', { name: 'Enregistrer' }))

    expect(await booking.findByText(/Lien enregistré/)).toBeInTheDocument()
    expect(api.puts.at(-1)).toEqual({ version: 0, contact_booking_url: 'https://calendly.com/circoe/30min' })
  })

  it('lists the next meetings read from Calendly, or says why it cannot', async () => {
    stub({
      initial: SAVED,
      calendlyEvents: {
        ok: true,
        code: null,
        events: [
          {
            uri: 'https://api.calendly.com/scheduled_events/E1',
            title: 'Échange IA 30 min',
            status: 'active',
            starts_at: '2026-11-20T09:00:00Z',
            ends_at: '2026-11-20T09:30:00Z',
            location: null,
            host_name: 'Hôte Circoe',
            host_email: 'hote@circoe.test',
            invitees: [{ name: 'Jean Test', email: 'jean@exemple.test', status: 'active' }],
          },
        ],
      },
    })
    renderApp('/config-ai/calendly')

    const list = within(await screen.findByRole('region', { name: 'Rendez-vous à venir' }))
    expect(await list.findByText('Échange IA 30 min')).toBeInTheDocument()
    expect(list.getByText('Jean Test')).toBeInTheDocument()
    expect(list.getByText('1 rendez-vous')).toBeInTheDocument()
  })

  it('shows the refusal when Calendly cannot be read', async () => {
    stub({ initial: SAVED, calendlyEvents: { ok: false, code: 'calendly_unauthorized', events: [] } })
    renderApp('/config-ai/calendly')

    const list = within(await screen.findByRole('region', { name: 'Rendez-vous à venir' }))
    expect(await list.findByRole('alert')).toHaveTextContent(/Calendly refuse ce jeton/)
  })
})
