import { screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'

import { integrations, stubIntegrationsApi } from '../test/integrationsApi'
import { renderApp } from '../test/render'
import { stubSettingsApi } from '../test/settingsApi'
import { stubToolboxApi } from '../test/toolboxApi'

// Paramètres › Connexions › Calendly: the token of the Agenda sync, write-only.

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

const card = async () => screen.findByRole('region', { name: 'Calendly' })

describe('Calendly card', () => {
  it('saves the token, never shows it again, and can remove it', async () => {
    const api = stub()
    renderApp('/settings/connections')

    const region = within(await card())
    expect(region.getByText('Non relié')).toBeInTheDocument()
    expect(region.getByRole('button', { name: 'Enregistrer le jeton' })).toBeDisabled()
    expect(region.getByRole('button', { name: 'Tester le jeton' })).toBeDisabled()

    await userEvent.type(region.getByLabelText('Jeton d’accès personnel Calendly'), TOKEN)
    await userEvent.click(region.getByRole('button', { name: 'Enregistrer le jeton' }))

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
    renderApp('/settings/connections')

    const region = within(await card())
    await userEvent.click(region.getByRole('button', { name: 'Tester le jeton' }))

    expect(await region.findByText('Jeton valide — compte Hôte Circoe · hote@circoe.test.')).toBeInTheDocument()
  })

  it('says in French why a token is refused', async () => {
    stub({ initial: SAVED, calendlyCheck: { ok: false, code: 'calendly_unauthorized', account: null, elapsed_ms: 100 } })
    renderApp('/settings/connections')

    const region = within(await card())
    await userEvent.click(region.getByRole('button', { name: 'Tester le jeton' }))

    expect(await region.findByText(/Calendly refuse ce jeton/)).toBeInTheDocument()
  })
})
