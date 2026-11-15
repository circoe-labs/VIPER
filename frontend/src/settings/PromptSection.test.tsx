import { screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'

import { integrations, stubIntegrationsApi } from '../test/integrationsApi'
import { renderApp } from '../test/render'
import { stubSettingsApi } from '../test/settingsApi'
import { stubToolboxApi } from '../test/toolboxApi'

const DEFAULT_TEXT = integrations().initial_prompt_default
const panel = () => screen.getByRole('dialog', { name: 'Tâche donnée à l’IA' })
const open = async () => {
  if (screen.queryByRole('dialog')) return
  await userEvent.click(await screen.findByRole('button', { name: 'Configurer : Écrire un mail' }))
}
const field = async () => {
  await open()
  return within(panel()).findByRole('textbox', { name: 'Prompt initial' })
}

function stub(options: Parameters<typeof stubIntegrationsApi>[0] = {}) {
  stubSettingsApi({})
  stubToolboxApi({})
  return stubIntegrationsApi(options)
}

describe('Paramètres › Prompt initial', () => {
  it('shows the built-in brief while none is saved, with nothing to save or reset', async () => {
    stub()
    renderApp('/config-ai/prompt')

    expect(await field()).toHaveValue(DEFAULT_TEXT)
    expect(within(panel()).getByRole('button', { name: 'Enregistrer' })).toBeDisabled()
    expect(within(panel()).getByRole('button', { name: 'Rétablir le texte par défaut' })).toBeDisabled()
  })

  it('saves an edited brief, then goes back to the built-in one', async () => {
    const { puts } = stub()
    const user = userEvent.setup()
    renderApp('/config-ai/prompt')

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
    renderApp('/config-ai/prompt')

    await user.clear(await field())

    expect(within(panel()).getByRole('button', { name: 'Enregistrer' })).toBeDisabled()
    expect(within(panel()).getByText(/ne peut pas être vide/)).toBeInTheDocument()
  })
})

describe('Config AI › Prompt › assistant de mission', () => {
  const missionPanel = () => screen.getByRole('dialog', { name: 'Assistant de création de mission' })
  const missionField = async () => {
    if (!screen.queryByRole('dialog')) {
      await userEvent.click(await screen.findByRole('button', { name: 'Configurer : Lancer l’assistant de création de mission' }))
    }
    return within(missionPanel()).findByRole('textbox', { name: 'Comportement de l’assistant' })
  }
  const MISSION_DEFAULT = integrations().mission_creator_prompt_default

  it('shows the built-in behaviour and saves an edited one under mission_creator_prompt, then resets it', async () => {
    const { puts } = stub()
    const user = userEvent.setup()
    renderApp('/config-ai/prompt')

    const box = await missionField()
    expect(box).toHaveValue(MISSION_DEFAULT)
    expect(within(missionPanel()).getByRole('button', { name: 'Rétablir le texte par défaut' })).toBeDisabled()
    await user.clear(box)
    await user.type(box, 'Pose une question à la fois.')
    await user.click(within(missionPanel()).getByRole('button', { name: 'Enregistrer' }))

    expect(await within(missionPanel()).findByText(/Comportement enregistré/)).toBeInTheDocument()
    expect(puts[0]).toEqual({ version: 0, mission_creator_prompt: 'Pose une question à la fois.' })

    await user.click(within(missionPanel()).getByRole('button', { name: 'Rétablir le texte par défaut' }))
    expect(await missionField()).toHaveValue(MISSION_DEFAULT)
    await user.click(within(missionPanel()).getByRole('button', { name: 'Enregistrer' }))
    await within(missionPanel()).findByText(/Valeur par défaut/)
    expect(puts[1]).toEqual({ version: 1, mission_creator_prompt: null })
  })
})
