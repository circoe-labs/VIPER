import { screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'

import { openConnection } from '../../test/connectionsUi'
import { integrations, stubIntegrationsApi } from '../../test/integrationsApi'
import { renderApp } from '../../test/render'
import { stubSettingsApi } from '../../test/settingsApi'
import { CONNECTED, stubToolboxApi, toolboxStatus } from '../../test/toolboxApi'

// Config AI › Connexions: one grid of identical tiles, one edit dialog per connection, the same footer everywhere.

function stub(options: Parameters<typeof stubIntegrationsApi>[0] = {}, status = toolboxStatus()) {
  stubSettingsApi({})
  stubToolboxApi({ status })
  return stubIntegrationsApi(options)
}

const SAVED = integrations(
  { openai_model: { value: 'modele-test', source: 'ui' } },
  {
    openai_api_key: { set: true, last4: '1234', source: 'ui', updated_at: null, updated_by: null },
    calendly_api_token: { set: true, last4: '9876', source: 'ui', updated_at: null, updated_by: null },
    humanizer_api_key: { set: true, last4: '5555', source: 'ui', updated_at: null, updated_by: null },
    generation_available: true,
  },
)

describe('the grid of connections', () => {
  it('is the default tab, with one tile per connection and no tab for Calendly or the Humanizer', async () => {
    stub()
    const { router } = renderApp('/config-ai')

    const tiles = await screen.findAllByRole('article')
    expect(tiles.map((t) => t.getAttribute('aria-label'))).toEqual(['OpenAI', 'CIRCOE Toolbox', 'Calendly', 'HumanGPT'])
    expect(router.state.location.pathname).toBe('/config-ai')
    const sections = screen.getByRole('navigation', { name: 'Sections de la configuration AI' })
    expect(within(sections).getByRole('link', { name: /Connexions/ })).toHaveAttribute('aria-current', 'page')
    const names = within(sections).getAllByRole('link').map((link) => link.textContent)
    expect(names.join(' ')).not.toMatch(/Calendly|Humanizer/)
  })

  it('gives every tile the same essentials: logo, title, which account or model, a badge, a quick test', async () => {
    stub({ initial: SAVED }, CONNECTED)
    renderApp('/config-ai/connections')

    const tiles = await screen.findAllByRole('article')
    for (const element of tiles) {
      const tile = within(element)
      expect(element.querySelector('.conn-tile__logo')).not.toBeNull()
      expect(element.querySelector('.conn-tile__title')?.textContent).toBeTruthy()
      expect(element.querySelector('.conn-tile__summary')?.textContent).toBeTruthy()
      expect(element.querySelector('.status-badge, [class*="badge"]')).not.toBeNull()
      expect(tile.getAllByRole('button')).toHaveLength(2)
      expect(tile.getByRole('button', { name: /^Configurer / })).toBeInTheDocument()
    }
    const openai = within(tiles[0] as HTMLElement)
    expect(openai.getByText('modele-test · clé …1234')).toBeInTheDocument()
  })

  it('quick-tests OpenAI from the tile: the badge answers, no dialog opens', async () => {
    stub({ initial: SAVED, check: { ok: false, code: 'ai_auth_failed', model: null, elapsed_ms: 100 } })
    renderApp('/config-ai/connections')

    const tile = within(await screen.findByRole('article', { name: 'OpenAI' }))
    await userEvent.click(tile.getByRole('button', { name: 'Tester la clé OpenAI' }))

    expect((await screen.findAllByText('Clé refusée')).length).toBeGreaterThan(0)
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('quick-tests the Toolbox by reading its state again', async () => {
    stubSettingsApi({})
    const toolbox = stubToolboxApi({ status: CONNECTED })
    stubIntegrationsApi()
    renderApp('/config-ai/connections')

    const tile = within(await screen.findByRole('article', { name: 'CIRCOE Toolbox' }))
    expect(tile.getAllByText('Connectée')[0]).toBeInTheDocument()
    toolbox.state.status = { ...CONNECTED, state: 'expired', connected: false }
    await userEvent.click(tile.getByRole('button', { name: 'Actualiser l’état de la Toolbox' }))

    expect((await screen.findAllByText('À reconnecter')).length).toBeGreaterThan(0)
  })
})

describe('the edit dialog', () => {
  it('opens on a click, is deep-linkable, and closes on Esc and on a click outside', async () => {
    stub()
    const { router } = renderApp('/config-ai/connections?open=calendly')

    expect(await screen.findByRole('dialog', { name: 'Calendly' })).toBeInTheDocument()
    await userEvent.keyboard('{Escape}')
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(router.state.location.search).toBe('')

    await userEvent.click(screen.getByRole('button', { name: 'Configurer OpenAI' }))
    expect(await screen.findByRole('dialog', { name: 'OpenAI' })).toBeInTheDocument()
    expect(router.state.location.search).toBe('?open=openai')
    await userEvent.click(document.querySelector('.dialog-backdrop') as HTMLElement)
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('lists each connection’s sub-tabs, the booking link and meetings living with Calendly', async () => {
    stub({}, CONNECTED)
    renderApp('/config-ai/connections')

    const tabs = async (title: string) => {
      const dialog = await openConnection(title)
      const names = dialog.getAllByRole('tab').map((tab) => tab.textContent)
      await userEvent.keyboard('{Escape}')
      return names
    }
    expect(await tabs('OpenAI')).toEqual(['Connexion', 'Avancé'])
    expect(await tabs('CIRCOE Toolbox')).toEqual(['Connexion', 'Envoi programmé', 'Méthodes', 'Diagnostic', 'Avancé'])
    expect(await tabs('Calendly')).toEqual(['Connexion', 'Lien de rendez-vous', 'Rendez-vous à venir'])
  })

  it('puts the primary action on the right of the footer and the secondary ones, as icons, on the left', async () => {
    stub({ initial: SAVED })
    renderApp('/config-ai/connections')

    const dialog = await openConnection('OpenAI')
    const save = dialog.getByRole('button', { name: 'Enregistrer' })
    expect(save.closest('.conn-actions__primary')).not.toBeNull()
    expect(save.closest('.dialog__footer')).not.toBeNull()
    for (const name of ['Tester la clé', 'Effacer…']) {
      const secondary = dialog.getByRole('button', { name })
      expect(secondary.closest('.conn-actions__secondary')).not.toBeNull()
      expect(secondary).toHaveClass('btn--icon')
      expect(secondary).toHaveAttribute('title')
    }
  })
})
