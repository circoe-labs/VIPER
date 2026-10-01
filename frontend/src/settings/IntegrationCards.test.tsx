import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'

import { integrations, stubIntegrationsApi } from '../test/integrationsApi'
import { renderApp } from '../test/render'
import { stubSettingsApi } from '../test/settingsApi'
import { stubToolboxApi } from '../test/toolboxApi'

// Paramètres › Connexions (Contact port S8): the integration settings typed in the browser.

const KEY = 'sk-test-cle-synthetique-1234'
const region = (name: string) => within(screen.getByRole('region', { name: 'Connexions' })).getByRole('region', { name })
const openai = () => region('Rédaction IA (OpenAI)')

function stub(options: Parameters<typeof stubIntegrationsApi>[0] = {}) {
  stubSettingsApi({})
  stubToolboxApi()
  return stubIntegrationsApi(options)
}

const SAVED_KEY = integrations(
  { openai_model: { value: 'modele-test', source: 'ui', updated_at: '2026-10-01T08:00:00+00:00', updated_by: 'Pilote Test' } },
  {
    openai_api_key: { set: true, last4: '1234', source: 'ui', updated_at: '2026-10-01T08:00:00+00:00', updated_by: 'Pilote Test' },
    generation_available: true,
  },
)

describe('Rédaction IA (OpenAI)', () => {
  it('saves a key and a model typed here, then never shows the key again', async () => {
    const api = stub()
    renderApp('/settings/connections')

    expect(await within(await screen.findByRole('region', { name: 'Rédaction IA (OpenAI)' })).findByText('Non configurée')).toBeInTheDocument()
    const save = within(openai()).getByRole('button', { name: 'Enregistrer' })
    expect(save).toBeDisabled()
    await userEvent.type(within(openai()).getByLabelText('Clé d’API OpenAI'), KEY)
    await userEvent.type(within(openai()).getByRole('textbox', { name: 'Modèle' }), 'modele-test')
    await userEvent.click(save)

    expect(await within(openai()).findByText(/Clé et réglages OpenAI enregistrés/)).toBeInTheDocument()
    expect(api.puts).toEqual([{ version: 0, openai_model: 'modele-test', openai_api_key: KEY }])
    expect(within(openai()).getByText('Configurée')).toBeInTheDocument()
    const input = within(openai()).getByLabelText('Clé d’API OpenAI')
    expect(input).toHaveValue('')
    expect(input).toHaveAttribute('placeholder', '•••• 1234 (enregistrée)')
    expect(input).toHaveAttribute('type', 'password')
    expect(input).toBeDisabled()
    expect(document.body.innerHTML).not.toContain(KEY)
  })

  it('replaces the key, and clears it after a confirmation', async () => {
    const api = stub({ initial: SAVED_KEY })
    renderApp('/settings/connections')

    await userEvent.click(await within(await screen.findByRole('region', { name: 'Rédaction IA (OpenAI)' })).findByRole('button', { name: 'Remplacer' }))
    const input = within(openai()).getByLabelText('Clé d’API OpenAI')
    await waitFor(() => {
      expect(input).toHaveFocus()
    })
    await userEvent.type(input, 'sk-test-nouvelle-cle-9876')
    await userEvent.click(within(openai()).getByRole('button', { name: 'Enregistrer' }))
    await waitFor(() => {
      expect(input).toHaveAttribute('placeholder', '•••• 9876 (enregistrée)')
    })

    await userEvent.click(within(openai()).getByRole('button', { name: 'Effacer…' }))
    const dialog = screen.getByRole('dialog', { name: 'Effacer la clé OpenAI ?' })
    await userEvent.click(within(dialog).getByRole('button', { name: 'Effacer la clé' }))

    expect(await within(openai()).findByText('Clé OpenAI effacée.')).toBeInTheDocument()
    expect(api.puts.at(-1)).toEqual({ version: 1, openai_api_key: null })
    expect(within(openai()).getByText('Non configurée')).toBeInTheDocument()
  })

  it('says where a value comes from and puts it back to the default', async () => {
    const api = stub({ initial: SAVED_KEY })
    renderApp('/settings/connections')

    const model = await within(await screen.findByRole('region', { name: 'Rédaction IA (OpenAI)' })).findByRole('textbox', { name: 'Modèle' })
    expect(model).toHaveValue('modele-test')
    expect(model).toHaveAccessibleDescription(/Défini ici par Pilote Test/)
    expect(within(openai()).getByRole('textbox', { name: 'Lien de prise de rendez-vous' })).toHaveAccessibleDescription(/Valeur par défaut/)

    await userEvent.click(within(openai()).getByRole('button', { name: 'Rétablir la valeur par défaut' }))

    expect(await within(openai()).findByText('Valeur par défaut rétablie.')).toBeInTheDocument()
    expect(api.puts).toEqual([{ version: 0, openai_model: null }])
    expect(model).toHaveValue('')
  })

  it('puts a refused value’s message under its field', async () => {
    stub({ refuseField: 'openai_base_url' })
    renderApp('/settings/connections')

    const card = await screen.findByRole('region', { name: 'Rédaction IA (OpenAI)' })
    await userEvent.click(within(card).getByText('Paramètres avancés'))
    const base = within(card).getByRole('textbox', { name: 'Adresse de l’API' })
    await userEvent.clear(base)
    await userEvent.type(base, 'ftp://ailleurs')
    await userEvent.click(within(card).getByRole('button', { name: 'Enregistrer' }))

    expect(await within(card).findByText(/Adresse http\(s\) complète attendue, par exemple/)).toBeInTheDocument()
    expect(base).toHaveAttribute('aria-invalid', 'true')
    expect(within(card).getByText(/Rien n’a été enregistré : corrigez le champ signalé/)).toBeInTheDocument()
  })

  it('refuses a timeout that is not a number before sending anything', async () => {
    const api = stub()
    renderApp('/settings/connections')

    const card = await screen.findByRole('region', { name: 'Rédaction IA (OpenAI)' })
    await userEvent.click(within(card).getByText('Paramètres avancés'))
    const timeout = within(card).getByRole('textbox', { name: 'Délai d’attente (secondes)' })
    expect(timeout).toHaveValue('60')
    await userEvent.clear(timeout)
    await userEvent.type(timeout, 'vite')
    await userEvent.click(within(card).getByRole('button', { name: 'Enregistrer' }))

    expect(await within(card).findByText('Indiquez un délai entre 1 et 300 secondes.')).toBeInTheDocument()
    expect(api.puts).toEqual([])
  })

  it('says when the settings changed meanwhile', async () => {
    stub({ conflict: true })
    renderApp('/settings/connections')

    const card = await screen.findByRole('region', { name: 'Rédaction IA (OpenAI)' })
    await userEvent.type(within(card).getByRole('textbox', { name: 'Modèle' }), 'autre')
    await userEvent.click(within(card).getByRole('button', { name: 'Enregistrer' }))

    expect(await within(card).findByText(/modifiés entre-temps/)).toBeInTheDocument()
  })

  it('tests the saved key and says the outcome', async () => {
    const api = stub({ initial: SAVED_KEY, check: { ok: false, code: 'ai_auth_failed', model: null, elapsed_ms: 300 } })
    renderApp('/settings/connections')

    const card = await screen.findByRole('region', { name: 'Rédaction IA (OpenAI)' })
    await userEvent.click(within(card).getByRole('button', { name: 'Tester la clé' }))

    expect(await within(card).findByText('Test échoué : la clé a été refusée par OpenAI.')).toBeInTheDocument()
    expect(api.checks).toHaveLength(1)
  })

  it('tests only a saved configuration', async () => {
    stub()
    renderApp('/settings/connections')

    const card = await screen.findByRole('region', { name: 'Rédaction IA (OpenAI)' })
    expect(within(card).getByRole('button', { name: 'Tester la clé' })).toBeDisabled()
  })

  it('reports a key accepted with its model', async () => {
    stub({ initial: SAVED_KEY })
    renderApp('/settings/connections')

    const card = await screen.findByRole('region', { name: 'Rédaction IA (OpenAI)' })
    await userEvent.click(within(card).getByRole('button', { name: 'Tester la clé' }))

    expect(await within(card).findByText(/Clé acceptée : le modèle « modele-test » est disponible/)).toBeInTheDocument()
  })
})

describe('Expéditeur and Envoi programmé', () => {
  it('saves the default sender', async () => {
    const api = stub()
    renderApp('/settings/connections')

    const card = await screen.findByRole('region', { name: 'Expéditeur' })
    await userEvent.type(within(card).getByRole('textbox', { name: 'Adresse « De » par défaut' }), 'prospection@exemple.example')
    await userEvent.click(within(card).getByRole('button', { name: 'Enregistrer' }))

    expect(await within(card).findByText(/Expéditeur enregistré/)).toBeInTheDocument()
    expect(api.puts).toEqual([{ version: 0, default_outbound_email: 'prospection@exemple.example' }])
  })

  it('turns the scheduled sending on with a frequency and an allowlist', async () => {
    const api = stub()
    renderApp('/settings/connections')

    const card = await screen.findByRole('region', { name: 'Envoi programmé' })
    const frequency = within(card).getByRole('combobox', { name: 'Fréquence de vérification' })
    expect(within(frequency).getAllByRole('option').map((option) => option.textContent)).toEqual([
      'Désactivé',
      'Toutes les 10 secondes',
      'Toutes les 30 secondes',
      'Toutes les minutes',
      'Toutes les 5 minutes',
    ])
    await userEvent.selectOptions(frequency, 'Toutes les 30 secondes')
    await userEvent.type(within(card).getByRole('textbox', { name: 'Adresses autorisées (facultatif)' }), '@exemple.example')
    await userEvent.click(within(card).getByRole('button', { name: 'Enregistrer' }))

    expect(await within(card).findByText(/Envoi programmé enregistré/)).toBeInTheDocument()
    expect(api.puts).toEqual([
      { version: 0, contact_dispatch_interval_ms: 30_000, infomaniak_send_allowlist: '@exemple.example' },
    ])
  })
})

describe('CIRCOE Toolbox › Paramètres avancés', () => {
  it('shows the built-in server address and saves a typed one', async () => {
    const api = stub()
    renderApp('/settings/connections')

    const card = await screen.findByRole('region', { name: 'CIRCOE Toolbox' })
    await userEvent.click(within(card).getByText('Paramètres avancés'))
    const server = within(card).getByRole('textbox', { name: 'Adresse du serveur CIRCOE Toolbox' })
    expect(server).toHaveValue('https://toolbox.exemple.example/mcp')
    const back = within(card).getByRole('textbox', { name: 'Adresse de retour' })
    expect(back).toHaveAttribute('placeholder', `${window.location.origin}/settings/connections`)
    // « Se connecter à CIRCOE Toolbox » stays the one primary action of the card.
    expect(within(card).getByRole('button', { name: 'Enregistrer les paramètres avancés' })).toHaveClass('btn--secondary')

    await userEvent.clear(server)
    await userEvent.type(server, 'https://autre.exemple.example/mcp')
    await userEvent.click(within(card).getByRole('button', { name: 'Enregistrer les paramètres avancés' }))

    expect(await within(card).findByText('Paramètres de la Toolbox enregistrés.')).toBeInTheDocument()
    expect(api.puts).toEqual([{ version: 0, toolbox_mcp_url: 'https://autre.exemple.example/mcp' }])
  })
})
