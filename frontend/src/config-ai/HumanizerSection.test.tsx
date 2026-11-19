import { screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'

import { integrations, stubIntegrationsApi } from '../test/integrationsApi'
import { renderApp } from '../test/render'
import { stubSettingsApi } from '../test/settingsApi'
import { stubToolboxApi } from '../test/toolboxApi'

// Config AI › Humanizer: the HumanGPT key (write-only), the switch, the minimal score and « Tester ».

const KEY = 'hgpt-cle-synthetique-5555'
const SAVED = integrations(
  {},
  { humanizer_api_key: { set: true, last4: '5555', source: 'ui', updated_at: '2026-11-18T08:00:00+00:00', updated_by: 'Pilote Test' } },
)

function stub(options: Parameters<typeof stubIntegrationsApi>[0] = {}) {
  stubSettingsApi({})
  stubToolboxApi()
  return stubIntegrationsApi(options)
}

const card = async () => screen.findByRole('region', { name: 'Humanizer (HumanGPT)' })

describe('Humanizer section', () => {
  it('is its own tab, saves the key without ever showing it again, and links to HumanGPT to create it', async () => {
    const api = stub()
    renderApp('/config-ai/humanizer')

    const region = within(await card())
    expect(screen.getByRole('link', { name: /^Humanizer/ })).toHaveAttribute('aria-current', 'page')
    expect(region.getByText('Non configuré')).toBeInTheDocument()
    expect(region.getByRole('link', { name: 'Créer la clé' })).toHaveAttribute('href', 'https://humangpt.io/account#api')
    expect(region.getByRole('button', { name: 'Tester' })).toBeDisabled()
    expect(region.getByRole('button', { name: 'Enregistrer' })).toBeDisabled()

    await userEvent.type(region.getByLabelText('Clé d’API HumanGPT'), KEY)
    await userEvent.click(region.getByRole('button', { name: 'Enregistrer' }))

    expect(await region.findByText('Clé et réglages Humanizer enregistrés.')).toBeInTheDocument()
    expect(api.puts.at(-1)).toMatchObject({ humanizer_api_key: KEY })
    expect(screen.queryByDisplayValue(KEY)).not.toBeInTheDocument()
    expect(region.getByPlaceholderText('•••• 5555 (enregistrée)')).toBeInTheDocument()
  })

  it('switches the check on and off at once, and saves the minimal score', async () => {
    const api = stub({ initial: SAVED })
    renderApp('/config-ai/humanizer')

    const region = within(await card())
    const toggle = region.getByRole('switch', { name: 'Contrôler le score avant la validation' })
    expect(toggle).not.toBeChecked()
    expect(region.getByText('Désactivé')).toBeInTheDocument()
    await userEvent.click(toggle)
    expect(await region.findByText(/Humanizer activé/)).toBeInTheDocument()
    expect(api.puts.at(-1)).toMatchObject({ humanizer_enabled: true })
    expect(await region.findByText('Actif')).toBeInTheDocument()

    const score = region.getByRole('textbox', { name: 'Score minimal (0 à 100)' })
    expect(score).toHaveValue('70')
    await userEvent.clear(score)
    await userEvent.type(score, '85')
    await userEvent.click(region.getByRole('button', { name: 'Enregistrer' }))
    expect(await region.findByText('Réglages Humanizer enregistrés.')).toBeInTheDocument()
    expect(api.puts.at(-1)).toMatchObject({ humanizer_min_score: 85 })

    await userEvent.clear(score)
    await userEvent.type(score, 'abc')
    await userEvent.click(region.getByRole('button', { name: 'Enregistrer' }))
    expect(await region.findByText('Indiquez un nombre entier de 0 à 100.')).toBeInTheDocument()
  })

  it('tests the saved key and says when HumanGPT refuses it', async () => {
    stub({ initial: SAVED, humanizerCheck: { ok: false, code: 'humanizer_auth_failed', elapsed_ms: 90 } })
    renderApp('/config-ai/humanizer')

    const region = within(await card())
    await userEvent.click(region.getByRole('button', { name: 'Tester' }))
    expect(await region.findByText(/HumanGPT refuse cette clé/)).toBeInTheDocument()
    expect(region.getByText('Clé refusée')).toBeInTheDocument()
  })
})
