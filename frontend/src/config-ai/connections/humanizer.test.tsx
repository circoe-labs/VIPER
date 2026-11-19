import { screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'

import { openConnection, tile } from '../../test/connectionsUi'
import { integrations, stubIntegrationsApi } from '../../test/integrationsApi'
import { renderApp } from '../../test/render'
import { stubSettingsApi } from '../../test/settingsApi'
import { stubToolboxApi } from '../../test/toolboxApi'

// Config AI › Connexions › HumanGPT (the Humanizer): the key (write-only), the switch, the minimal score and the test.

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

describe('HumanGPT connection', () => {
  it('has no tab of its own: the old address opens its dialog in the grid', async () => {
    stub()
    renderApp('/config-ai/humanizer')

    expect(await screen.findByRole('dialog', { name: 'HumanGPT' })).toBeInTheDocument()
    expect(screen.queryByRole('link', { name: /^Humanizer/ })).not.toBeInTheDocument()
  })

  it('saves the key without ever showing it again, and links to HumanGPT to create it', async () => {
    const api = stub()
    renderApp('/config-ai/connections')

    expect((await tile('HumanGPT')).getAllByText('Non configuré')[0]).toBeInTheDocument()
    const dialog = await openConnection('HumanGPT')
    expect(dialog.getByRole('link', { name: 'Créer la clé' })).toHaveAttribute('href', 'https://humangpt.io/account#api')
    expect(dialog.getByRole('button', { name: 'Tester' })).toBeDisabled()
    expect(dialog.getByRole('button', { name: 'Enregistrer' })).toBeDisabled()

    await userEvent.type(dialog.getByLabelText('Clé d’API HumanGPT'), KEY)
    await userEvent.click(dialog.getByRole('button', { name: 'Enregistrer' }))

    expect(await dialog.findByText('Clé et réglages Humanizer enregistrés.')).toBeInTheDocument()
    expect(api.puts.at(-1)).toMatchObject({ humanizer_api_key: KEY })
    expect(screen.queryByDisplayValue(KEY)).not.toBeInTheDocument()
    expect(dialog.getByPlaceholderText('•••• 5555 (enregistrée)')).toBeInTheDocument()
  })

  it('switches the check on and off at once, and saves the minimal score', async () => {
    const api = stub({ initial: SAVED })
    renderApp('/config-ai/connections')

    expect((await tile('HumanGPT')).getAllByText('Désactivé')[0]).toBeInTheDocument()
    const dialog = await openConnection('HumanGPT')
    const toggle = dialog.getByRole('switch', { name: 'Contrôler le score avant la validation' })
    expect(toggle).not.toBeChecked()
    await userEvent.click(toggle)
    expect(await dialog.findByText(/Humanizer activé/)).toBeInTheDocument()
    expect(api.puts.at(-1)).toMatchObject({ humanizer_enabled: true })
    expect((await tile('HumanGPT')).getAllByText('Actif')[0]).toBeInTheDocument()

    const score = dialog.getByRole('textbox', { name: 'Score minimal (0 à 100)' })
    expect(score).toHaveValue('70')
    await userEvent.clear(score)
    await userEvent.type(score, '85')
    await userEvent.click(dialog.getByRole('button', { name: 'Enregistrer' }))
    expect(await dialog.findByText('Réglages Humanizer enregistrés.')).toBeInTheDocument()
    expect(api.puts.at(-1)).toMatchObject({ humanizer_min_score: 85 })

    await userEvent.clear(score)
    await userEvent.type(score, 'abc')
    await userEvent.click(dialog.getByRole('button', { name: 'Enregistrer' }))
    expect(await dialog.findByText('Indiquez un nombre entier de 0 à 100.')).toBeInTheDocument()
  })

  it('tests the saved key and says when HumanGPT refuses it', async () => {
    stub({ initial: SAVED, humanizerCheck: { ok: false, code: 'humanizer_auth_failed', elapsed_ms: 90 } })
    renderApp('/config-ai/connections')

    const dialog = await openConnection('HumanGPT')
    await userEvent.click(dialog.getByRole('button', { name: 'Tester' }))
    expect(await dialog.findByText(/HumanGPT refuse cette clé/)).toBeInTheDocument()
  })

  it('tests from the tile, and the badge says the key is refused', async () => {
    stub({ initial: SAVED, humanizerCheck: { ok: false, code: 'humanizer_auth_failed', elapsed_ms: 90 } })
    renderApp('/config-ai/connections')

    await userEvent.click((await tile('HumanGPT')).getByRole('button', { name: 'Tester la clé HumanGPT' }))
    expect((await tile('HumanGPT')).getAllByText('Clé refusée')[0]).toBeInTheDocument()
  })
})
