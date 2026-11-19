import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'

import { openConnection, tile } from '../../test/connectionsUi'
import { integrations, stubIntegrationsApi } from '../../test/integrationsApi'
import { renderApp } from '../../test/render'
import { stubSettingsApi } from '../../test/settingsApi'
import { stubToolboxApi } from '../../test/toolboxApi'

// Config AI › Connexions › OpenAI: the key (write-only), the model and the technical options, in one dialog.

const KEY = 'sk-test-cle-synthetique-1234'

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

describe('OpenAI', () => {
  it('saves a key and a model typed here, then never shows the key again', async () => {
    const api = stub()
    renderApp('/config-ai/connections')

    expect((await tile('OpenAI')).getAllByText('Non configurée')[0]).toBeInTheDocument()
    const openai = await openConnection('OpenAI')
    const save = openai.getByRole('button', { name: 'Enregistrer' })
    expect(save).toBeDisabled()
    await userEvent.type(openai.getByLabelText('Clé d’API OpenAI'), KEY)
    await userEvent.type(openai.getByRole('textbox', { name: 'Modèle' }), 'modele-test')
    await userEvent.click(save)

    expect(await openai.findByText(/Clé et réglages OpenAI enregistrés/)).toBeInTheDocument()
    expect(api.puts).toEqual([{ version: 0, openai_model: 'modele-test', openai_api_key: KEY }])
    expect((await tile('OpenAI')).getAllByText('Configurée')[0]).toBeInTheDocument()
    const input = openai.getByLabelText('Clé d’API OpenAI')
    expect(input).toHaveValue('')
    expect(input).toHaveAttribute('placeholder', '•••• 1234 (enregistrée)')
    expect(input).toHaveAttribute('type', 'password')
    expect(input).toBeDisabled()
    expect(document.body.innerHTML).not.toContain(KEY)
  })

  it('replaces the key, and clears it after a confirmation', async () => {
    const api = stub({ initial: SAVED_KEY })
    renderApp('/config-ai/connections')

    const openai = await openConnection('OpenAI')
    await userEvent.click(openai.getByRole('button', { name: 'Remplacer' }))
    const input = openai.getByLabelText('Clé d’API OpenAI')
    await waitFor(() => {
      expect(input).toHaveFocus()
    })
    await userEvent.type(input, 'sk-test-nouvelle-cle-9876')
    await userEvent.click(openai.getByRole('button', { name: 'Enregistrer' }))
    await waitFor(() => {
      expect(input).toHaveAttribute('placeholder', '•••• 9876 (enregistrée)')
    })

    await userEvent.click(openai.getByRole('button', { name: 'Effacer…' }))
    const dialog = screen.getByRole('dialog', { name: 'Effacer la clé OpenAI ?' })
    await userEvent.click(within(dialog).getByRole('button', { name: 'Effacer la clé' }))

    expect(await openai.findByText('Clé OpenAI effacée.')).toBeInTheDocument()
    expect(api.puts.at(-1)).toEqual({ version: 1, openai_api_key: null })
    expect((await tile('OpenAI')).getAllByText('Non configurée')[0]).toBeInTheDocument()
  })

  it('says where a value comes from and puts it back to the default', async () => {
    const api = stub({ initial: SAVED_KEY })
    renderApp('/config-ai/connections')

    const openai = await openConnection('OpenAI')
    const model = await openai.findByRole('textbox', { name: 'Modèle' })
    expect(model).toHaveValue('modele-test')
    // The explanation and the source of the value live behind the « i » of the label.
    expect(openai.getByRole('button', { name: 'Aide : Modèle' })).toHaveAccessibleDescription(/Défini ici par Pilote Test/)
    // The booking link lives with Calendly.
    expect(openai.queryByRole('textbox', { name: /rendez-vous|réservation/i })).not.toBeInTheDocument()

    const reset = openai.getByRole('button', { name: 'Rétablir' })
    expect(reset).toHaveAttribute('title', 'Rétablir la valeur par défaut : aucune valeur')
    await userEvent.click(reset)

    expect(await openai.findByText('Valeur par défaut rétablie.')).toBeInTheDocument()
    expect(api.puts).toEqual([{ version: 0, openai_model: null }])
    expect(model).toHaveValue('')
  })

  it('puts a refused value’s message under its field', async () => {
    stub({ refuseField: 'openai_base_url' })
    renderApp('/config-ai/connections')

    const openai = await openConnection('OpenAI', 'Avancé')
    const base = openai.getByRole('textbox', { name: 'Adresse de l’API' })
    await userEvent.clear(base)
    await userEvent.type(base, 'ftp://ailleurs')
    await userEvent.click(openai.getByRole('button', { name: 'Enregistrer' }))

    expect(await openai.findByText(/Adresse http\(s\) complète attendue, par exemple/)).toBeInTheDocument()
    expect(base).toHaveAttribute('aria-invalid', 'true')
    expect(openai.getByText(/Rien n’a été enregistré : corrigez le champ signalé/)).toBeInTheDocument()
  })

  it('refuses a timeout that is not a number before sending anything', async () => {
    const api = stub()
    renderApp('/config-ai/connections')

    const openai = await openConnection('OpenAI', 'Avancé')
    const timeout = openai.getByRole('textbox', { name: 'Délai d’attente (secondes)' })
    expect(timeout).toHaveValue('60')
    await userEvent.clear(timeout)
    await userEvent.type(timeout, 'vite')
    await userEvent.click(openai.getByRole('button', { name: 'Enregistrer' }))

    expect(await openai.findByText('Indiquez un délai entre 1 et 300 secondes.')).toBeInTheDocument()
    expect(api.puts).toEqual([])
  })

  it('keeps what was typed in a tab when another tab is shown, and saves both at once', async () => {
    const api = stub()
    renderApp('/config-ai/connections')

    const openai = await openConnection('OpenAI')
    await userEvent.type(openai.getByRole('textbox', { name: 'Modèle' }), 'autre')
    await userEvent.click(openai.getByRole('tab', { name: 'Avancé' }))
    const retries = openai.getByRole('textbox', { name: 'Nouvelles tentatives' })
    await userEvent.clear(retries)
    await userEvent.type(retries, '3')
    await userEvent.click(openai.getByRole('tab', { name: 'Connexion' }))
    expect(openai.getByRole('textbox', { name: 'Modèle' })).toHaveValue('autre')
    await userEvent.click(openai.getByRole('button', { name: 'Enregistrer' }))

    expect(await openai.findByText(/Réglages OpenAI enregistrés/)).toBeInTheDocument()
    expect(api.puts).toEqual([{ version: 0, openai_model: 'autre', openai_max_retries: 3 }])
  })

  it('says when the settings changed meanwhile', async () => {
    stub({ conflict: true })
    renderApp('/config-ai/connections')

    const openai = await openConnection('OpenAI')
    await userEvent.type(openai.getByRole('textbox', { name: 'Modèle' }), 'autre')
    await userEvent.click(openai.getByRole('button', { name: 'Enregistrer' }))

    expect(await openai.findByText(/modifiés entre-temps/)).toBeInTheDocument()
  })

  it('tests the saved key from the footer and says the outcome', async () => {
    const api = stub({ initial: SAVED_KEY, check: { ok: false, code: 'ai_auth_failed', model: null, elapsed_ms: 300 } })
    renderApp('/config-ai/connections')

    const openai = await openConnection('OpenAI')
    await userEvent.click(openai.getByRole('button', { name: 'Tester la clé' }))

    expect(await openai.findByText('Test échoué : la clé a été refusée par OpenAI.')).toBeInTheDocument()
    expect(api.checks).toHaveLength(1)
  })

  it('tests only a saved configuration', async () => {
    stub()
    renderApp('/config-ai/connections')

    const openai = await openConnection('OpenAI')
    expect(openai.getByRole('button', { name: 'Tester la clé' })).toBeDisabled()
    await userEvent.click(openai.getByRole('button', { name: 'Fermer' }))
    expect(screen.getByRole('button', { name: 'Tester la clé OpenAI' })).toBeDisabled()
  })

  it('reports a key accepted with its model', async () => {
    stub({ initial: SAVED_KEY })
    renderApp('/config-ai/connections')

    const openai = await openConnection('OpenAI')
    await userEvent.click(openai.getByRole('button', { name: 'Tester la clé' }))

    expect(await openai.findByText(/Clé acceptée : le modèle « modele-test » est disponible/)).toBeInTheDocument()
  })
})

describe('« Modèle » lists the models of the OpenAI account', () => {
  it('offers the models the saved key can use and saves the one chosen', async () => {
    const api = stub({ initial: SAVED_KEY, models: { models: ['gpt-test-2', 'gpt-test-1'], code: null } })
    renderApp('/config-ai/connections')

    const openai = await openConnection('OpenAI')
    const select = await openai.findByRole('combobox', { name: 'Modèle' })
    const options = within(select).getAllByRole('option').map((option) => option.textContent)
    // The saved value is kept even though the service no longer lists it.
    expect(options).toEqual(['Choisir un modèle…', 'modele-test (absent de la liste)', 'gpt-test-2', 'gpt-test-1'])
    expect(select).toHaveValue('modele-test')
    await userEvent.selectOptions(select, 'gpt-test-2')
    await userEvent.click(openai.getByRole('button', { name: 'Enregistrer' }))

    expect(await openai.findByText(/Réglages OpenAI enregistrés/)).toBeInTheDocument()
    expect(api.puts).toEqual([{ version: 0, openai_model: 'gpt-test-2' }])
  })

  it('falls back to a typed identifier when the service gives no list, and says why', async () => {
    stub({ initial: SAVED_KEY, models: { models: [], code: 'ai_auth_failed' } })
    renderApp('/config-ai/connections')

    const openai = await openConnection('OpenAI')
    expect(await openai.findByText(/Liste des modèles indisponible : la clé a été refusée par OpenAI/)).toBeInTheDocument()
    expect(openai.getByRole('textbox', { name: 'Modèle' })).toHaveValue('modele-test')
  })
})

describe('the key and its API address (S8 QA M1)', () => {
  it('warns that a new API address needs the key again, and opens the key when the server says so', async () => {
    const api = stub({ initial: SAVED_KEY, refuseField: 'openai_api_key', refuseReason: 'required_with_base_url' })
    renderApp('/config-ai/connections')

    const openai = await openConnection('OpenAI', 'Avancé')
    const base = openai.getByRole('textbox', { name: 'Adresse de l’API' })
    await userEvent.clear(base)
    await userEvent.type(base, 'https://proxy.exemple.example/v1')
    await userEvent.click(openai.getByRole('tab', { name: 'Connexion' }))
    const key = openai.getByLabelText('Clé d’API OpenAI')
    expect(key).toHaveAccessibleDescription(/demande de saisir la clé à nouveau/)

    await userEvent.click(openai.getByRole('button', { name: 'Enregistrer' }))

    expect(await openai.findByText(/une clé n’est jamais envoyée à une autre adresse/)).toBeInTheDocument()
    expect(key).toBeEnabled()
    expect(api.puts).toEqual([{ version: 0, openai_base_url: 'https://proxy.exemple.example/v1' }])
  })
})
