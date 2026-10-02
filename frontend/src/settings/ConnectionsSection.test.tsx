import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { leaveFor } from '../lib/browser'
import { integrations, stubIntegrationsApi } from '../test/integrationsApi'
import { renderApp } from '../test/render'
import { stubSettingsApi } from '../test/settingsApi'
import { AUTHORIZE_URL, CONNECTED, stubToolboxApi, toolboxStatus } from '../test/toolboxApi'

vi.mock('../lib/browser', () => ({ leaveFor: vi.fn() }))

const panel = () => screen.getByRole('region', { name: 'Connexions' })
const card = () => within(panel()).getByRole('region', { name: 'CIRCOE Toolbox' })
const dispatchCard = () => within(panel()).getByRole('region', { name: 'Envoi programmé' })

function stub(options: Parameters<typeof stubToolboxApi>[0] = {}, settings: Parameters<typeof stubIntegrationsApi>[0] = {}) {
  stubSettingsApi({})
  const toolbox = stubToolboxApi(options)
  const integrationsApi = stubIntegrationsApi(settings)
  return { ...toolbox, integrationsApi }
}

afterEach(() => {
  vi.mocked(leaveFor).mockClear()
})

describe('Paramètres › Connexions', () => {
  it('flips the card to the allowed MCP methods and refreshes them', async () => {
    const { fetchMock } = stub({ status: CONNECTED })
    const user = userEvent.setup()
    renderApp('/settings/connections')

    await user.click(await within(panel()).findByRole('button', { name: 'Méthodes autorisées' }))
    const list = await within(card()).findByRole('list', { name: 'Méthodes MCP autorisées' })
    expect(list).toHaveTextContent('infomaniak.mail.create_draft')
    expect(list).toHaveTextContent('Brouillons')
    expect(card()).toHaveTextContent('2 méthodes autorisées')
    expect(card()).not.toHaveTextContent('30 jours')

    const toolCalls = () => fetchMock.mock.calls.filter(([url]) => (url as string).endsWith('/settings/toolbox/tools')).length
    const before = toolCalls()
    await user.click(within(card()).getByRole('button', { name: 'Actualiser' }))
    await waitFor(() => {
      expect(toolCalls()).toBe(before + 1)
    })

    await user.click(within(card()).getByRole('button', { name: 'Retour à la connexion' }))
    expect(card()).toHaveTextContent('30 jours')
  })

  it('says why the methods cannot be read', async () => {
    stub({ status: CONNECTED, toolsRefusal: 'toolbox_unavailable' })
    const user = userEvent.setup()
    renderApp('/settings/connections')

    await user.click(await within(panel()).findByRole('button', { name: 'Méthodes autorisées' }))
    expect(await within(card()).findByRole('alert')).toHaveTextContent('la Toolbox ne répond pas')
  })

  it('is the fifth section and offers to connect from a fresh install', async () => {
    stub({ status: toolboxStatus({ enabled: false, configured: false, state: 'disabled', toolbox_origin: null }) })
    renderApp('/settings/connections')

    const sections = screen.getByRole('navigation', { name: 'Sections des paramètres' })
    expect(within(sections).getByRole('link', { name: /Connexions/ })).toHaveAttribute('aria-current', 'page')
    expect(await within(panel()).findByText('Désactivée')).toBeInTheDocument()
    expect(card()).toHaveTextContent('Connectez VIPER à CIRCOE Toolbox')
    expect(within(card()).getByRole('button', { name: 'Se connecter à CIRCOE Toolbox' })).toBeEnabled()
    expect(within(card()).queryByRole('button', { name: 'Se déconnecter…' })).not.toBeInTheDocument()
    expect(card()).toHaveTextContent('boîte Infomaniak par défaut du compte connecté')
    expect(card()).toHaveTextContent('30 jours')
    // Never an environment variable to set, nor a restart.
    expect(panel().textContent).not.toMatch(/VIPER_|redémarr/)
  })

  it('says whether scheduled messages really leave, the last pass and what waits (S7)', async () => {
    stub(
      {
        status: {
          ...CONNECTED,
          dispatch: {
            running: true,
            active: true,
            interval_seconds: 30,
            last_pass_at: '2026-10-01T07:05:00+00:00',
            last_outcome: 'ok',
            scheduled: 3,
            unconfirmed: 1,
          },
        },
      },
      { initial: integrations({}, { dispatch: { running: true, active: true, reason: null, scheduled_count: 3, overdue_count: 0 } }) },
    )
    renderApp('/settings/connections')

    expect(await within(panel()).findByText('Actif')).toBeInTheDocument()
    expect(dispatchCard()).toHaveTextContent('Actif : chaque mail programmé part à l’heure choisie')
    expect(dispatchCard()).toHaveTextContent('Messages programmés3')
    expect(dispatchCard()).toHaveTextContent('1 à trancher dans Contact')
    expect(dispatchCard()).not.toHaveTextContent('ne partiront pas')
  })

  it('is on by default: one switch, explained in plain words, the delay in the advanced settings (S9)', async () => {
    stub({ status: CONNECTED })
    renderApp('/settings/connections')

    const toggle = await within(await screen.findByRole('region', { name: 'Envoi programmé' })).findByRole('switch', {
      name: 'Envoi automatique des mails programmés',
    })
    expect(toggle).toBeChecked()
    expect(dispatchCard()).toHaveTextContent(
      'VIPER envoie chaque mail programmé à l’heure choisie (à 30 secondes près) via CIRCOE Toolbox.',
    )
    expect(dispatchCard()).not.toHaveTextContent(/Fréquence de vérification|désactivé par défaut/i)
    expect(within(dispatchCard()).getByRole('textbox', { name: 'Délai maximal avant envoi (secondes)' })).not.toBeVisible()
    expect(dispatchCard()).toHaveTextContent('aucune depuis le démarrage')
  })

  it('waits for the Toolbox when switched on but nothing is connected, and counts what will not leave (S9)', async () => {
    stub(
      {},
      {
        initial: integrations(
          {},
          { dispatch: { running: false, active: false, reason: 'toolbox_disconnected', scheduled_count: 2, overdue_count: 1 } },
        ),
      },
    )
    renderApp('/settings/connections')

    expect(await within(panel()).findByText('En attente')).toBeInTheDocument()
    expect(dispatchCard()).toHaveTextContent('En attente : CIRCOE Toolbox n’est pas connectée.')
    expect(within(dispatchCard()).getByText(/^2 messages programmés ne partiront pas \(1 a déjà dépassé son heure\)/)).toHaveClass(
      'settings-feedback--warning',
    )
  })

  it('says the sending is off when the person switched it off, and how many messages wait (S9)', async () => {
    stub(
      { status: CONNECTED },
      {
        initial: integrations(
          { contact_dispatch_enabled: { value: false, source: 'ui' } },
          { dispatch: { running: false, active: false, reason: 'disabled', scheduled_count: 1, overdue_count: 0 } },
        ),
      },
    )
    renderApp('/settings/connections')

    expect(await within(panel()).findByText('Désactivé : les dates d’envoi sont enregistrées', { exact: false })).toBeInTheDocument()
    expect(within(dispatchCard()).getByRole('switch', { name: 'Envoi automatique des mails programmés' })).not.toBeChecked()
    expect(dispatchCard()).toHaveTextContent('1 message programmé ne partira pas tant que l’envoi automatique est inactif.')
  })

  it('names a missing address in the page’s words and opens the advanced settings', async () => {
    stub({ status: toolboxStatus({ state: 'not_configured', configured: false, missing: ['VIPER_TOOLBOX_MCP_URL'] }) })
    renderApp('/settings/connections')

    expect(await within(await screen.findByRole('region', { name: 'CIRCOE Toolbox' })).findByText('Non configurée')).toBeInTheDocument()
    expect(card()).toHaveTextContent('Il manque l’adresse du serveur CIRCOE Toolbox')
    expect(card()).not.toHaveTextContent('VIPER_')
    expect(within(card()).getByRole('textbox', { name: 'Adresse du serveur CIRCOE Toolbox' })).toBeVisible()
  })

  it('keeps the advanced settings open once the missing address is saved, so the outcome stays visible', async () => {
    const api = stub({ status: toolboxStatus({ state: 'not_configured', configured: false, missing: ['VIPER_TOOLBOX_MCP_URL'] }) })
    renderApp('/settings/connections')

    const server = await within(await screen.findByRole('region', { name: 'CIRCOE Toolbox' })).findByRole('textbox', {
      name: 'Adresse du serveur CIRCOE Toolbox',
    })
    await userEvent.clear(server)
    await userEvent.type(server, 'https://autre.exemple.example/mcp')
    // The server now has its address: the next status read says « Non connectée ».
    api.state.status = toolboxStatus()
    await userEvent.click(within(card()).getByRole('button', { name: 'Enregistrer les paramètres avancés' }))

    expect(await within(card()).findByText('Non connectée')).toBeInTheDocument()
    expect(within(card()).getByText('Paramètres de la Toolbox enregistrés.')).toBeVisible()
    expect(server).toBeVisible()
  })

  it('connects by sending this page’s address, then the browser to the Toolbox', async () => {
    const api = stub()
    renderApp('/settings/connections')

    await userEvent.click(await screen.findByRole('button', { name: 'Se connecter à CIRCOE Toolbox' }))

    await waitFor(() => {
      expect(leaveFor).toHaveBeenCalledWith(AUTHORIZE_URL)
    })
    expect(api.connects).toEqual([{ redirect_uri: `${window.location.origin}/settings/connections` }])
  })

  it('says why the connection cannot start', async () => {
    stub({ connectRefusal: 'toolbox_unavailable' })
    renderApp('/settings/connections')

    await userEvent.click(await screen.findByRole('button', { name: 'Se connecter à CIRCOE Toolbox' }))

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

  it('disconnects after a confirmation: token forgotten, integration off', async () => {
    stub({ status: { ...CONNECTED, cleanups: { pending: 2, failing: 1 } } })
    renderApp('/settings/connections')

    expect(await screen.findByText(/2 brouillons obsolètes en attente/)).toHaveTextContent('dont 1 en échec')
    await userEvent.click(screen.getByRole('button', { name: 'Se déconnecter…' }))
    const dialog = screen.getByRole('dialog', { name: 'Se déconnecter de CIRCOE Toolbox ?' })
    expect(dialog).toHaveTextContent('ne propose pas de révocation')
    expect(dialog).toHaveTextContent('l’envoi programmé s’arrête')
    await userEvent.click(within(dialog).getByRole('button', { name: 'Se déconnecter' }))

    expect(await within(panel()).findByText(/Déconnecté de CIRCOE Toolbox/)).toBeInTheDocument()
    expect(card()).toHaveTextContent('Désactivée')
    expect(within(card()).getByRole('button', { name: 'Se connecter à CIRCOE Toolbox' })).toBeEnabled()
  })

  it('flags an expired connection on the tab', async () => {
    stub({ status: { ...CONNECTED, state: 'expired', connected: false } })
    renderApp('/settings/roles')

    const sections = screen.getByRole('navigation', { name: 'Sections des paramètres' })
    expect(await within(sections).findByText('À reconnecter')).toBeInTheDocument()
  })

  it('says where the settings live and that a file left unread was ignored', async () => {
    stub({}, { initial: integrations({}, { load_error: 'invalid', load_dropped: ['openai_timeout_ms'], updated_at: '2026-10-01T08:00:00+00:00', updated_by: 'Pilote Test' }) })
    renderApp('/settings/connections')

    expect(await within(panel()).findByText(/n’ont pas pu être relus au démarrage du serveur/)).toHaveTextContent('pour : délai d’attente.')
    expect(panel()).toHaveTextContent('runtime-settings.json')
    expect(panel()).toHaveTextContent('par Pilote Test')
  })
})
