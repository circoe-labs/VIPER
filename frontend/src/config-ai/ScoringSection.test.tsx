import { screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'

import { integrations, stubIntegrationsApi } from '../test/integrationsApi'
import { renderApp } from '../test/render'
import { stubSettingsApi } from '../test/settingsApi'
import { stubToolboxApi } from '../test/toolboxApi'

function stub(options: Parameters<typeof stubIntegrationsApi>[0] = {}) {
  stubSettingsApi({})
  stubToolboxApi({})
  return stubIntegrationsApi(options)
}

describe('Config AI › Scoring prospect', () => {
  it('is its own tab and points to Connexions for the key and the model (no second field)', async () => {
    stub()
    renderApp('/config-ai/scoring')

    const tabs = await screen.findByRole('navigation', { name: 'Sections de la configuration AI' })
    expect(within(tabs).getByRole('link', { name: /Scoring prospect/ })).toHaveAttribute('aria-current', 'page')
    const panel = screen.getByRole('region', { name: 'Scoring prospect' })
    expect(within(panel).getByRole('link', { name: 'Connexions' })).toHaveAttribute('href', '/config-ai/connections')
    expect(screen.queryByRole('textbox', { name: /clé/i })).not.toBeInTheDocument()
    expect(await screen.findByRole('button', { name: 'Configurer : Évaluer un prospect' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Configurer : Cible de Circoe' })).toBeInTheDocument()
  })

  it('edits the system prompt, saves it, and « Rétablir » goes back to the built-in text', async () => {
    const { puts } = stub()
    const user = userEvent.setup()
    renderApp('/config-ai/scoring')

    await user.click(await screen.findByRole('button', { name: 'Configurer : Évaluer un prospect' }))
    const dialog = screen.getByRole('dialog', { name: 'Consigne du score prospect' })
    const box = within(dialog).getByRole('textbox', { name: 'Consigne d’évaluation' })
    expect(box).toHaveValue(integrations().prospect_scoring_prompt_default)
    await user.clear(box)
    await user.type(box, 'Sois strict.')
    await user.click(within(dialog).getByRole('button', { name: 'Enregistrer' }))

    expect(await within(dialog).findByText(/Consigne enregistrée/)).toBeInTheDocument()
    expect(puts[0]).toEqual({ version: 0, prospect_scoring_prompt: 'Sois strict.' })

    await user.click(within(dialog).getByRole('button', { name: 'Rétablir le texte par défaut' }))
    await user.click(within(dialog).getByRole('button', { name: 'Enregistrer' }))
    await within(dialog).findByText(/Valeur par défaut/)
    expect(puts[1]).toEqual({ version: 1, prospect_scoring_prompt: null })
  })

  it('saves the Circoe target', async () => {
    const { puts } = stub()
    const user = userEvent.setup()
    renderApp('/config-ai/scoring')

    await user.click(await screen.findByRole('button', { name: 'Configurer : Cible de Circoe' }))
    const dialog = screen.getByRole('dialog', { name: 'Cible de Circoe' })
    const box = within(dialog).getByRole('textbox', { name: 'Cible de Circoe' })
    await user.clear(box)
    await user.type(box, 'Les cimenteries du Grand Est.')
    await user.click(within(dialog).getByRole('button', { name: 'Enregistrer' }))

    expect(await within(dialog).findByText(/Cible enregistrée/)).toBeInTheDocument()
    expect(puts[0]).toEqual({ version: 0, circoe_target: 'Les cimenteries du Grand Est.' })
  })

  it('« Tester sur un prospect » shows the score, the rationale, the criteria and the provenance', async () => {
    const { scoringTests } = stub()
    const user = userEvent.setup()
    renderApp('/config-ai/scoring')

    await user.click(await screen.findByRole('button', { name: 'Tester sur un prospect' }))

    const result = await screen.findByText(/Jeanne Vatinel/)
    expect(result.closest('.scoring-test__result')).toHaveTextContent('82 sur 100')
    expect(screen.getByText('Forte adéquation.')).toBeInTheDocument()
    expect(screen.getByRole('list', { name: 'Critères' })).toHaveTextContent('+25')
    expect(screen.getByText(/Modèle modele-test · prompt a1b2c3d4/)).toBeInTheDocument()
    expect(scoringTests).toHaveLength(1)
  })

  it('a failed test says why, pointing to Config AI, and releases the button', async () => {
    stub({ scoringTest: [503, { detail: { code: 'ai_not_configured', message: 'x' } }] })
    const user = userEvent.setup()
    renderApp('/config-ai/scoring')

    await user.click(await screen.findByRole('button', { name: 'Tester sur un prospect' }))

    expect(await screen.findByRole('alert')).toHaveTextContent(/Config AI › Connexions/)
    expect(screen.getByRole('button', { name: 'Tester sur un prospect' })).toBeEnabled()
  })
})
