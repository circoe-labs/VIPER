import { screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'

import { openConnection, tile } from '../../test/connectionsUi'
import { integrations, stubIntegrationsApi } from '../../test/integrationsApi'
import { renderApp } from '../../test/render'
import { stubSettingsApi } from '../../test/settingsApi'
import { stubToolboxApi } from '../../test/toolboxApi'

// Config AI › Connexions › Calendly: the token (write-only), the booking link and the meetings read live — one
// connection, three sub-tabs, no page of its own.

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

describe('Calendly connection', () => {
  it('has no tab of its own: the old address opens its dialog in the grid', async () => {
    stub()
    const { router } = renderApp('/config-ai/calendly')

    expect(await screen.findByRole('dialog', { name: 'Calendly' })).toBeInTheDocument()
    expect(router.state.location.pathname).toBe('/config-ai/connections')
    expect(screen.queryByRole('link', { name: /^Calendly/ })).not.toBeInTheDocument()
  })

  it('saves the token, never shows it again, and can remove it', async () => {
    const api = stub()
    renderApp('/config-ai/connections')

    expect((await tile('Calendly')).getAllByText('Non relié')[0]).toBeInTheDocument()
    const dialog = await openConnection('Calendly')
    expect(dialog.getByRole('button', { name: 'Enregistrer' })).toBeDisabled()
    expect(dialog.getByRole('button', { name: 'Tester' })).toBeDisabled()

    await userEvent.type(dialog.getByLabelText('Jeton d’accès personnel'), TOKEN)
    await userEvent.click(dialog.getByRole('button', { name: 'Enregistrer' }))

    expect(await dialog.findByText('Jeton enregistré : la synchronisation démarre.')).toBeInTheDocument()
    expect(api.puts.at(-1)).toMatchObject({ calendly_api_token: TOKEN })
    expect(screen.queryByDisplayValue(TOKEN)).not.toBeInTheDocument()
    expect(dialog.getByPlaceholderText('•••• 9876 (enregistré)')).toBeInTheDocument()

    await userEvent.click(dialog.getByRole('button', { name: 'Retirer' }))
    expect(await dialog.findByText('Jeton retiré : la synchronisation est arrêtée.')).toBeInTheDocument()
    expect(api.puts.at(-1)).toMatchObject({ calendly_api_token: null })
  })

  it('tests the saved token and says whose account it is', async () => {
    stub({ initial: SAVED })
    renderApp('/config-ai/connections')

    const dialog = await openConnection('Calendly')
    await userEvent.click(dialog.getByRole('button', { name: 'Tester' }))

    expect(await dialog.findByText('Connecté : Hôte Circoe · hote@circoe.test.')).toBeInTheDocument()
    expect(dialog.getByText('Compte Calendly : Hôte Circoe · hote@circoe.test')).toBeInTheDocument()
  })

  it('tests from the tile too, and the badge says the outcome', async () => {
    stub({ initial: SAVED })
    renderApp('/config-ai/connections')

    const calendly = await tile('Calendly')
    await userEvent.click(calendly.getByRole('button', { name: 'Tester la connexion Calendly' }))

    expect((await tile('Calendly')).getAllByText('Connecté')[0]).toBeInTheDocument()
  })

  it('says in French why a token is refused', async () => {
    stub({ initial: SAVED, calendlyCheck: { ok: false, code: 'calendly_unauthorized', account: null, elapsed_ms: 100 } })
    renderApp('/config-ai/connections')

    const dialog = await openConnection('Calendly')
    await userEvent.click(dialog.getByRole('button', { name: 'Tester' }))

    expect(await dialog.findByText(/Calendly refuse ce jeton/)).toBeInTheDocument()
  })

  it('keeps the booking link in its own tab and saves it', async () => {
    const api = stub()
    renderApp('/config-ai/connections')

    const dialog = await openConnection('Calendly', 'Lien de rendez-vous')
    await userEvent.type(dialog.getByRole('textbox', { name: 'Lien de réservation' }), 'https://calendly.com/circoe/30min')
    await userEvent.click(dialog.getByRole('button', { name: 'Enregistrer' }))

    expect(await dialog.findByText(/Lien enregistré/)).toBeInTheDocument()
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
    renderApp('/config-ai/connections')

    const dialog = await openConnection('Calendly', 'Rendez-vous à venir')
    expect(await dialog.findByText('Échange IA 30 min')).toBeInTheDocument()
    expect(dialog.getByText('Jean Test')).toBeInTheDocument()
    expect(dialog.getByText(/1 rendez-vous/)).toBeInTheDocument()
  })

  it('shows the refusal when Calendly cannot be read', async () => {
    stub({ initial: SAVED, calendlyEvents: { ok: false, code: 'calendly_unauthorized', events: [] } })
    renderApp('/config-ai/connections')

    const dialog = await openConnection('Calendly', 'Rendez-vous à venir')
    expect(await dialog.findByRole('alert')).toHaveTextContent(/Calendly refuse ce jeton/)
  })
})
