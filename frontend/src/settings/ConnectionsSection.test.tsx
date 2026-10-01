import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { leaveFor } from '../lib/browser'
import { renderApp } from '../test/render'
import { stubSettingsApi } from '../test/settingsApi'
import { AUTHORIZE_URL, CONNECTED, stubToolboxApi, toolboxStatus } from '../test/toolboxApi'

vi.mock('../lib/browser', () => ({ leaveFor: vi.fn() }))

const panel = () => screen.getByRole('region', { name: 'Connexions' })
const card = () => within(panel()).getByRole('region', { name: 'CIRCOE Toolbox' })

function stub(options: Parameters<typeof stubToolboxApi>[0] = {}) {
  stubSettingsApi({})
  return stubToolboxApi(options)
}

afterEach(() => {
  vi.mocked(leaveFor).mockClear()
})

describe('Paramètres › Connexions', () => {
  it('is the fifth section and says what each state means', async () => {
    stub({ status: toolboxStatus({ enabled: false, configured: false, state: 'disabled', toolbox_origin: null }) })
    renderApp('/settings/connections')

    const sections = screen.getByRole('navigation', { name: 'Sections des paramètres' })
    expect(within(sections).getByRole('link', { name: /Connexions/ })).toHaveAttribute('aria-current', 'page')
    expect(await within(panel()).findByText('Désactivée')).toBeInTheDocument()
    expect(card()).toHaveTextContent('rien n’est créé dans Infomaniak')
    expect(within(card()).queryByRole('button')).not.toBeInTheDocument()
    expect(card()).toHaveTextContent('boîte Infomaniak par défaut du compte connecté')
    expect(card()).toHaveTextContent('30 jours')
  })

  it('names the missing settings when not configured', async () => {
    stub({ status: toolboxStatus({ state: 'not_configured', configured: false, missing: ['VIPER_TOOLBOX_MCP_URL'] }) })
    renderApp('/settings/connections')

    expect(await within(panel()).findByText('Non configurée')).toBeInTheDocument()
    expect(card()).toHaveTextContent('VIPER_TOOLBOX_MCP_URL')
  })

  it('connects by sending the browser to the Toolbox', async () => {
    stub()
    renderApp('/settings/connections')

    await userEvent.click(await screen.findByRole('button', { name: 'Connecter la Toolbox' }))

    await waitFor(() => {
      expect(leaveFor).toHaveBeenCalledWith(AUTHORIZE_URL)
    })
  })

  it('says why the connection cannot start', async () => {
    stub({ connectRefusal: 'toolbox_unavailable' })
    renderApp('/settings/connections')

    await userEvent.click(await screen.findByRole('button', { name: 'Connecter la Toolbox' }))

    expect(await within(panel()).findByText(/Connexion à la Toolbox impossible : la Toolbox ne répond pas/)).toBeVisible()
    expect(leaveFor).not.toHaveBeenCalled()
  })

  it('finishes the OAuth return once and cleans the address bar', async () => {
    const api = stub()
    const { router } = renderApp('/settings/connections?code=code-1&state=etat-1&iss=https%3A%2F%2Ftoolbox')

    expect(await within(panel()).findByText(/CIRCOE Toolbox connectée jusqu’au/)).toBeInTheDocument()
    expect(api.callbacks).toEqual([{ state: 'etat-1', code: 'code-1', iss: 'https://toolbox', error: '' }])
    expect(router.state.location.search).toBe('')
    expect(card()).toHaveTextContent('Connectée')
    expect(card()).toHaveTextContent('Pilote Test')
  })

  it('says a refused return in French and records it', async () => {
    stub({ callbackRefusal: 'toolbox_access_denied' })
    renderApp('/settings/connections?error=access_denied&state=etat-2')

    expect(
      await within(panel()).findByText(/Connexion à la Toolbox impossible : connexion refusée dans la Toolbox/),
    ).toBeInTheDocument()
    expect(await screen.findByText(/Dernier échec/)).toHaveTextContent('connexion refusée')
  })

  it('forgets the connection after a confirmation', async () => {
    stub({ status: { ...CONNECTED, cleanups: { pending: 2, failing: 1 } } })
    renderApp('/settings/connections')

    expect(await screen.findByText(/2 brouillons obsolètes en attente/)).toHaveTextContent('dont 1 en échec')
    await userEvent.click(screen.getByRole('button', { name: 'Oublier la connexion…' }))
    const dialog = screen.getByRole('dialog', { name: 'Oublier la connexion à la Toolbox ?' })
    expect(dialog).toHaveTextContent('ne propose pas de révocation')
    await userEvent.click(within(dialog).getByRole('button', { name: 'Oublier la connexion' }))

    expect(await within(panel()).findByText(/Connexion oubliée/)).toBeInTheDocument()
    expect(card()).toHaveTextContent('Non connectée')
  })

  it('flags an expired connection on the tab', async () => {
    stub({ status: { ...CONNECTED, state: 'expired', connected: false } })
    renderApp('/settings/roles')

    const sections = screen.getByRole('navigation', { name: 'Sections des paramètres' })
    expect(await within(sections).findByText('À reconnecter')).toBeInTheDocument()
  })
})
