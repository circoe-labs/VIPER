import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { leaveFor } from '../../lib/browser'
import { openConnection, tile } from '../../test/connectionsUi'
import { integrations, stubIntegrationsApi } from '../../test/integrationsApi'
import { renderApp } from '../../test/render'
import { stubSettingsApi } from '../../test/settingsApi'
import { AUTHORIZE_URL, CONNECTED, stubToolboxApi, toolboxStatus } from '../../test/toolboxApi'

vi.mock('../../lib/browser', () => ({ leaveFor: vi.fn() }))

// Config AI › Connexions › CIRCOE Toolbox: the Infomaniak link, the scheduled sending, the methods, the diagnostic and
// the advanced addresses — ONE connection, five sub-tabs.

const TOOLBOX = 'CIRCOE Toolbox'
const SENDING = 'Envoi programmé'
const panel = () => screen.getByRole('region', { name: 'Connexions' })

function stub(options: Parameters<typeof stubToolboxApi>[0] = {}, settings: Parameters<typeof stubIntegrationsApi>[0] = {}) {
  stubSettingsApi({})
  const toolbox = stubToolboxApi(options)
  const integrationsApi = stubIntegrationsApi(settings)
  return { ...toolbox, integrationsApi }
}

afterEach(() => {
  vi.mocked(leaveFor).mockClear()
})

describe('CIRCOE Toolbox › Connexion', () => {
  it('shows the allowed MCP methods in their own tab and reads them again', async () => {
    const { fetchMock } = stub({ status: CONNECTED })
    const user = userEvent.setup()
    renderApp('/config-ai/connections')

    const dialog = await openConnection(TOOLBOX, 'Méthodes')
    const list = await dialog.findByRole('list', { name: 'Méthodes MCP autorisées' })
    expect(list).toHaveTextContent('infomaniak.mail.create_draft')
    expect(list).toHaveTextContent('Brouillons')
    expect(await dialog.findByText('2 méthodes autorisées pour cette connexion.')).toBeInTheDocument()

    const toolCalls = () => fetchMock.mock.calls.filter(([url]) => (url as string).endsWith('/settings/toolbox/tools')).length
    const before = toolCalls()
    await user.click(dialog.getByRole('button', { name: 'Relire les méthodes' }))
    await waitFor(() => {
      expect(toolCalls()).toBe(before + 1)
    })

    await user.click(dialog.getByRole('tab', { name: 'Connexion' }))
    expect(dialog.getByText('Valable jusqu’au')).toBeInTheDocument()
  })

  it('reads the methods only once their tab is shown', async () => {
    const { fetchMock } = stub({ status: CONNECTED })
    renderApp('/config-ai/connections')

    const dialog = await openConnection(TOOLBOX)
    expect(dialog.getByRole('tab', { name: 'Méthodes' })).toBeInTheDocument()
    expect(fetchMock.mock.calls.some(([url]) => (url as string).endsWith('/settings/toolbox/tools'))).toBe(false)
  })

  it('says why the methods cannot be read', async () => {
    stub({ status: CONNECTED, toolsRefusal: 'toolbox_unavailable' })
    renderApp('/config-ai/connections')

    const dialog = await openConnection(TOOLBOX, 'Méthodes')
    expect(await dialog.findByRole('alert')).toHaveTextContent('la Toolbox ne répond pas')
  })

  it('is the first Config AI section and offers to connect from a fresh install', async () => {
    stub({ status: toolboxStatus({ enabled: false, configured: false, state: 'disabled', toolbox_origin: null }) })
    renderApp('/config-ai/connections')

    const sections = screen.getByRole('navigation', { name: 'Sections de la configuration AI' })
    expect(within(sections).getByRole('link', { name: /Connexions/ })).toHaveAttribute('aria-current', 'page')
    expect((await tile(TOOLBOX)).getAllByText('Désactivée')[0]).toBeInTheDocument()
    const dialog = await openConnection(TOOLBOX)
    expect(dialog.getByText(/Connectez VIPER à CIRCOE Toolbox/)).toBeInTheDocument()
    expect(dialog.getByRole('button', { name: 'Se connecter à CIRCOE Toolbox' })).toBeEnabled()
    expect(dialog.queryByRole('button', { name: 'Se déconnecter…' })).not.toBeInTheDocument()
    expect(dialog.queryByRole('tab', { name: 'Méthodes' })).not.toBeInTheDocument()
    // The limitations sit behind the « i », not in a paragraph.
    expect(dialog.getByRole('button', { name: 'Aide : limites de la connexion' })).toHaveAccessibleDescription(/boîte Infomaniak par défaut/)
    // Never an environment variable to set, nor a restart.
    expect(screen.getByRole('dialog').textContent).not.toMatch(/VIPER_|redémarr/)
  })

  it('connects by sending this page’s address, then the browser to the Toolbox', async () => {
    const api = stub()
    renderApp('/config-ai/connections')

    const dialog = await openConnection(TOOLBOX)
    await userEvent.click(dialog.getByRole('button', { name: 'Se connecter à CIRCOE Toolbox' }))

    await waitFor(() => {
      expect(leaveFor).toHaveBeenCalledWith(AUTHORIZE_URL)
    })
    expect(api.connects).toEqual([{ redirect_uri: `${window.location.origin}/settings/connections` }])
  })

  it('says why the connection cannot start', async () => {
    stub({ connectRefusal: 'toolbox_unavailable' })
    renderApp('/config-ai/connections')

    const dialog = await openConnection(TOOLBOX)
    await userEvent.click(dialog.getByRole('button', { name: 'Se connecter à CIRCOE Toolbox' }))

    expect(await dialog.findByText(/Connexion à la Toolbox impossible : la Toolbox ne répond pas/)).toBeVisible()
    expect(leaveFor).not.toHaveBeenCalled()
  })

  it('finishes the OAuth return once, opens the Toolbox dialog and cleans the address bar', async () => {
    const api = stub()
    const { router } = renderApp('/settings/connections?code=code-1&state=etat-1&iss=https%3A%2F%2Ftoolbox')

    const dialog = within(await screen.findByRole('dialog', { name: TOOLBOX }))
    expect(await dialog.findByText(/CIRCOE Toolbox connectée jusqu’au/)).toBeInTheDocument()
    expect(api.callbacks).toEqual([{ state: 'etat-1', code: 'code-1', iss: 'https://toolbox', error: '' }])
    expect(router.state.location.search).toBe('?open=toolbox')
    expect(router.state.location.pathname).toBe('/config-ai/connections')
    expect((await tile(TOOLBOX)).getAllByText('Connectée')[0]).toBeInTheDocument()
    expect(await dialog.findByText('Pilote Test')).toBeInTheDocument()
  })

  it('says a refused return in French and records it', async () => {
    stub({ callbackRefusal: 'toolbox_access_denied' })
    renderApp('/settings/connections?error=access_denied&state=etat-2')

    const dialog = within(await screen.findByRole('dialog', { name: TOOLBOX }))
    expect(
      await dialog.findByText(/Connexion à la Toolbox impossible : connexion refusée dans la Toolbox/),
    ).toBeInTheDocument()
    expect(await dialog.findByText(/Dernier échec/)).toHaveTextContent('connexion refusée')
  })

  it('disconnects after a confirmation: token forgotten, integration off', async () => {
    stub({ status: { ...CONNECTED, cleanups: { pending: 2, failing: 1 } } })
    renderApp('/config-ai/connections')

    const toolbox = await openConnection(TOOLBOX)
    expect(await toolbox.findByText(/2 brouillons obsolètes en attente/)).toHaveTextContent('dont 1 en échec')
    await userEvent.click(toolbox.getByRole('button', { name: 'Se déconnecter…' }))
    const dialog = screen.getByRole('dialog', { name: 'Se déconnecter de CIRCOE Toolbox ?' })
    expect(dialog).toHaveTextContent('ne propose pas de révocation')
    expect(dialog).toHaveTextContent('l’envoi programmé s’arrête')
    await userEvent.click(within(dialog).getByRole('button', { name: 'Se déconnecter' }))

    expect(await toolbox.findByText(/Déconnecté de CIRCOE Toolbox/)).toBeInTheDocument()
    expect((await tile(TOOLBOX)).getAllByText('Désactivée')[0]).toBeInTheDocument()
    expect(toolbox.getByRole('button', { name: 'Se connecter à CIRCOE Toolbox' })).toBeEnabled()
  })

  it('flags an expired connection on the tab', async () => {
    stub({ status: { ...CONNECTED, state: 'expired', connected: false } })
    renderApp('/config-ai/mcp')

    const sections = screen.getByRole('navigation', { name: 'Sections de la configuration AI' })
    expect(await within(sections).findByText('À reconnecter')).toBeInTheDocument()
  })

  it('says where the settings live and that a file left unread was ignored', async () => {
    stub({}, { initial: integrations({}, { load_error: 'invalid', load_dropped: ['openai_timeout_ms'], updated_at: '2026-10-01T08:00:00+00:00', updated_by: 'Pilote Test' }) })
    renderApp('/config-ai/connections')

    expect(await within(panel()).findByText(/n’ont pas pu être relus au démarrage du serveur/)).toHaveTextContent('pour : délai d’attente.')
    expect(panel()).toHaveTextContent('runtime-settings.json')
    expect(panel()).toHaveTextContent('par Pilote Test')
  })
})

describe('CIRCOE Toolbox › Envoi programmé', () => {
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
    renderApp('/config-ai/connections')

    const dialog = await openConnection(TOOLBOX, SENDING)
    expect(dialog.getByText('Actif')).toBeInTheDocument()
    expect(dialog.getByRole('button', { name: 'Aide : Envoi programmé' })).toHaveAccessibleDescription(
      /Actif : chaque mail programmé part à l’heure choisie/,
    )
    expect(dialog.getByText('Messages programmés').nextElementSibling).toHaveTextContent('3')
    expect(dialog.getByText('1 à trancher dans Contact')).toBeInTheDocument()
    expect(dialog.queryByText(/ne partiront pas/)).not.toBeInTheDocument()
  })

  it('is on by default: one switch, explained in plain words, the delay in the same tab (S9)', async () => {
    stub({ status: CONNECTED })
    renderApp('/config-ai/connections')

    const dialog = await openConnection(TOOLBOX, SENDING)
    expect(dialog.getByRole('switch', { name: 'Envoi automatique des mails programmés' })).toBeChecked()
    expect(dialog.getByRole('button', { name: 'Aide : Envoi programmé' })).toHaveAccessibleDescription(
      /à l’heure choisie \(à 30 secondes près\)/,
    )
    expect(dialog.queryByText(/Fréquence de vérification|désactivé par défaut/i)).not.toBeInTheDocument()
    expect(dialog.getByRole('textbox', { name: 'Délai maximal avant envoi (secondes)' })).toBeVisible()
    expect(dialog.getByText('aucune depuis le démarrage')).toBeInTheDocument()
  })

  it('has no default sender: the connected Toolbox account is the sender', async () => {
    stub()
    renderApp('/config-ai/connections')

    const dialog = await openConnection(TOOLBOX, SENDING)
    expect(dialog.queryByRole('textbox', { name: /Adresse « De »/ })).not.toBeInTheDocument()
    expect(screen.queryByRole('region', { name: 'Expéditeur' })).not.toBeInTheDocument()
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
    renderApp('/config-ai/connections')

    const dialog = await openConnection(TOOLBOX, SENDING)
    expect(dialog.getByText('En attente')).toBeInTheDocument()
    expect(dialog.getByRole('button', { name: 'Aide : Envoi programmé' })).toHaveAccessibleDescription(
      /En attente : CIRCOE Toolbox n’est pas connectée\./,
    )
    expect(dialog.getByText(/^2 messages programmés ne partiront pas \(1 a déjà dépassé son heure\)/)).toHaveClass(
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
    renderApp('/config-ai/connections')

    const dialog = await openConnection(TOOLBOX, SENDING)
    expect(dialog.getByRole('button', { name: 'Aide : Envoi programmé' })).toHaveAccessibleDescription(
      /Désactivé : les dates d’envoi sont enregistrées/,
    )
    expect(dialog.getByRole('switch', { name: 'Envoi automatique des mails programmés' })).not.toBeChecked()
    expect(dialog.getByText('1 message programmé ne partira pas tant que l’envoi automatique est inactif.')).toBeInTheDocument()
  })

  it('says a settings file the server cannot write, in French', async () => {
    stub({}, { storageUnavailable: true })
    renderApp('/config-ai/connections')

    const dialog = await openConnection(TOOLBOX, SENDING)
    await userEvent.click(dialog.getByRole('switch', { name: 'Envoi automatique des mails programmés' }))

    expect(await dialog.findByText(/ne peut pas être écrit sur le serveur/)).toBeInTheDocument()
  })

  it('switches the scheduled sending off and on at once (S9)', async () => {
    const api = stub()
    renderApp('/config-ai/connections')

    const dialog = await openConnection(TOOLBOX, SENDING)
    const toggle = dialog.getByRole('switch', { name: 'Envoi automatique des mails programmés' })
    await userEvent.click(toggle)
    expect(await dialog.findByText(/^Envoi automatique désactivé : aucun mail programmé ne partira/)).toBeInTheDocument()
    expect(toggle).not.toBeChecked()
    expect(dialog.getByText('Désactivé')).toBeInTheDocument()
    await userEvent.click(toggle)
    expect(await dialog.findByText(/^Envoi automatique activé/)).toBeInTheDocument()
    expect(toggle).toBeChecked()
    expect(api.integrationsApi.puts).toEqual([
      { version: 0, contact_dispatch_enabled: false },
      { version: 1, contact_dispatch_enabled: true },
    ])
  })

  it('saves the delay (in seconds) and an allowlist, and refuses an impossible delay (S9)', async () => {
    const api = stub()
    renderApp('/config-ai/connections')

    const dialog = await openConnection(TOOLBOX, SENDING)
    const delay = dialog.getByRole('textbox', { name: 'Délai maximal avant envoi (secondes)' })
    expect(delay).toHaveValue('30')
    await userEvent.clear(delay)
    await userEvent.type(delay, '0')
    await userEvent.click(dialog.getByRole('button', { name: 'Enregistrer' }))
    expect(dialog.getByText('Indiquez un délai entre 1 et 3 600 secondes.')).toBeInTheDocument()
    expect(api.integrationsApi.puts).toEqual([])

    await userEvent.clear(delay)
    await userEvent.type(delay, '10')
    await userEvent.type(dialog.getByRole('textbox', { name: 'Adresses autorisées (facultatif)' }), '@exemple.example')
    await userEvent.click(dialog.getByRole('button', { name: 'Enregistrer' }))

    expect(await dialog.findByText(/Envoi programmé enregistré/)).toBeInTheDocument()
    expect(api.integrationsApi.puts).toEqual([
      { version: 0, contact_dispatch_interval_ms: 10_000, infomaniak_send_allowlist: '@exemple.example' },
    ])
  })
})

describe('CIRCOE Toolbox › Avancé', () => {
  it('opens on the missing address, in the page’s words, and keeps showing the outcome once it is saved', async () => {
    const api = stub({ status: toolboxStatus({ state: 'not_configured', configured: false, missing: ['VIPER_TOOLBOX_MCP_URL'] }) })
    renderApp('/config-ai/connections')

    expect((await tile(TOOLBOX)).getAllByText('Non configurée')[0]).toBeInTheDocument()
    const dialog = await openConnection(TOOLBOX)
    const server = dialog.getByRole('textbox', { name: 'Adresse du serveur CIRCOE Toolbox' })
    expect(server).toBeVisible()
    await userEvent.click(dialog.getByRole('tab', { name: 'Connexion' }))
    expect(dialog.getByText(/Il manque l’adresse du serveur CIRCOE Toolbox/)).toBeInTheDocument()
    expect(screen.getByRole('dialog').textContent).not.toContain('VIPER_')
    await userEvent.click(dialog.getByRole('tab', { name: 'Avancé' }))

    await userEvent.clear(server)
    await userEvent.type(server, 'https://autre.exemple.example/mcp')
    // The server now has its address: the next status read says « Non connectée ».
    api.state.status = toolboxStatus()
    await userEvent.click(dialog.getByRole('button', { name: 'Enregistrer' }))

    expect(await dialog.findByText('Paramètres de la Toolbox enregistrés.')).toBeVisible()
    expect((await tile(TOOLBOX)).getAllByText('Non connectée')[0]).toBeInTheDocument()
    expect(server).toBeVisible()
  })

  it('asks before changing the server address of a connected Toolbox (it disconnects it)', async () => {
    stubSettingsApi({})
    stubToolboxApi({ status: CONNECTED })
    const api = stubIntegrationsApi()
    renderApp('/config-ai/connections')

    const toolbox = await openConnection(TOOLBOX, 'Avancé')
    const server = toolbox.getByRole('textbox', { name: 'Adresse du serveur CIRCOE Toolbox' })
    await userEvent.clear(server)
    await userEvent.type(server, 'https://autre.exemple.example/mcp')
    await userEvent.click(toolbox.getByRole('button', { name: 'Enregistrer' }))

    const dialog = screen.getByRole('dialog', { name: 'Changer l’adresse du serveur ?' })
    expect(dialog).toHaveTextContent('déconnecte la Toolbox')
    expect(api.puts).toEqual([])
    await userEvent.click(within(dialog).getByRole('button', { name: 'Changer et déconnecter' }))

    expect(await toolbox.findByText('Paramètres de la Toolbox enregistrés.')).toBeInTheDocument()
    expect(api.puts).toEqual([{ version: 0, toolbox_mcp_url: 'https://autre.exemple.example/mcp' }])
  })

  it('shows the built-in server address and saves a typed one', async () => {
    const api = stub()
    renderApp('/config-ai/connections')

    const dialog = await openConnection(TOOLBOX, 'Avancé')
    const server = dialog.getByRole('textbox', { name: 'Adresse du serveur CIRCOE Toolbox' })
    expect(server).toHaveValue('https://toolbox.exemple.example/mcp')
    const back = dialog.getByRole('textbox', { name: 'Adresse de retour' })
    expect(back).toHaveAttribute('placeholder', `${window.location.origin}/settings/connections`)

    await userEvent.clear(server)
    await userEvent.type(server, 'https://autre.exemple.example/mcp')
    await userEvent.click(dialog.getByRole('button', { name: 'Enregistrer' }))

    expect(await dialog.findByText('Paramètres de la Toolbox enregistrés.')).toBeInTheDocument()
    expect(api.integrationsApi.puts).toEqual([{ version: 0, toolbox_mcp_url: 'https://autre.exemple.example/mcp' }])
  })
})
