import { screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'

import { integrations, stubIntegrationsApi } from '../test/integrationsApi'
import { renderApp } from '../test/render'
import { stubSettingsApi } from '../test/settingsApi'
import { stubToolboxApi } from '../test/toolboxApi'

const DEFAULT_TEXT = integrations().initial_prompt_default
const panel = () => screen.getByRole('region', { name: 'Prompt initial' })
const field = () => within(panel()).findByRole('textbox', { name: 'Prompt initial' })

function stub(options: Parameters<typeof stubIntegrationsApi>[0] = {}) {
  stubSettingsApi({})
  stubToolboxApi({})
  return stubIntegrationsApi(options)
}

describe('Paramètres › Prompt initial', () => {
  it('shows the built-in brief while none is saved, with nothing to save or reset', async () => {
    stub()
    renderApp('/settings/prompt')

    expect(await field()).toHaveValue(DEFAULT_TEXT)
    expect(within(panel()).getByRole('button', { name: 'Enregistrer' })).toBeDisabled()
    expect(within(panel()).getByRole('button', { name: 'Rétablir le texte par défaut' })).toBeDisabled()
  })

  it('saves an edited brief, then goes back to the built-in one', async () => {
    const { puts } = stub()
    const user = userEvent.setup()
    renderApp('/settings/prompt')

    const box = await field()
    await user.clear(box)
    await user.type(box, 'Tu écris pour Circoe.')
    await user.click(within(panel()).getByRole('button', { name: 'Enregistrer' }))

    expect(await within(panel()).findByText(/Prompt initial enregistré/)).toBeInTheDocument()
    expect(puts[0]).toEqual({ version: 0, contact_initial_prompt: 'Tu écris pour Circoe.' })
    expect(await field()).toHaveValue('Tu écris pour Circoe.')

    await user.click(within(panel()).getByRole('button', { name: 'Rétablir le texte par défaut' }))
    expect(await field()).toHaveValue(DEFAULT_TEXT)
    await user.click(within(panel()).getByRole('button', { name: 'Enregistrer' }))

    await within(panel()).findByText(/Valeur par défaut/)
    expect(puts[1]).toEqual({ version: 1, contact_initial_prompt: null })
  })

  it('refuses an empty brief', async () => {
    stub()
    const user = userEvent.setup()
    renderApp('/settings/prompt')

    await user.clear(await field())

    expect(within(panel()).getByRole('button', { name: 'Enregistrer' })).toBeDisabled()
    expect(within(panel()).getByText(/ne peut pas être vide/)).toBeInTheDocument()
  })
})
