import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'

import type { Diagnostic, DiagnosticStep } from '../api/toolboxDiagnostic'
import { stubIntegrationsApi } from '../test/integrationsApi'
import { renderApp } from '../test/render'
import { stubSettingsApi } from '../test/settingsApi'
import { stubToolboxApi } from '../test/toolboxApi'

const card = () => within(screen.getByRole('region', { name: 'Connexions' })).getByRole('region', { name: 'Tester la Toolbox' })

function step(key: string, overrides: Partial<DiagnosticStep> = {}): DiagnosticStep {
  return {
    key,
    title: `Étape ${key}`,
    expectation: 'Doit réussir.',
    status: 'ok',
    started_at: '2026-10-08T08:00:00Z',
    duration_ms: 120,
    context: {},
    observed: {},
    error: null,
    note: null,
    trace: [],
    ...overrides,
  }
}

function run(overrides: Partial<Diagnostic> = {}): Diagnostic {
  return {
    id: 'a1',
    recipient: 'test@circoe.com',
    send_real: false,
    delay_seconds: 60,
    started_at: '2026-10-08T08:00:00Z',
    finished_at: '2026-10-08T08:00:09Z',
    status: 'done',
    steps: [step('create')],
    verdict: { ok: true, counts: { ok: 1 }, problems: [], first_problem: null },
    crash: null,
    ...overrides,
  }
}

function stub(options: Parameters<typeof stubIntegrationsApi>[0] = {}) {
  stubSettingsApi({})
  stubToolboxApi({})
  return stubIntegrationsApi(options)
}

describe('Paramètres › Connexions › Tester la Toolbox', () => {
  it('clears the shown result', async () => {
    stub({ diagnostic: run() })
    const user = userEvent.setup()
    renderApp('/settings/connections')

    await user.click(await within(await screen.findByRole('region', { name: 'Tester la Toolbox' })).findByRole('button', { name: 'Effacer le résultat' }))

    expect(await within(card()).findByText(/Aucun test lancé/)).toBeInTheDocument()
    expect(within(card()).queryByText('Tout fonctionne')).not.toBeInTheDocument()
  })

  it('starts a run on the test address, remembering it, and shows the answer', async () => {
    const { diagnostic } = stub({ startedDiagnostic: run() })
    const user = userEvent.setup()
    renderApp('/settings/connections')

    const start = await within(await screen.findByRole('region', { name: 'Tester la Toolbox' })).findByRole('button', {
      name: 'Lancer le diagnostic',
    })
    expect(start).toBeDisabled()
    await user.type(within(card()).getByLabelText('Adresse de test'), 'test@circoe.com')
    await user.click(start)

    await waitFor(() => {
      expect(diagnostic.starts).toEqual([{ recipient: 'test@circoe.com', send_real: false, delay_seconds: 60 }])
    })
    expect(await within(card()).findByText('Tout fonctionne')).toBeInTheDocument()
    expect(card()).toHaveTextContent('Brouillons seulement')
  })

  it('sends for real only when ticked, with the chosen delay', async () => {
    const { diagnostic } = stub({ startedDiagnostic: run({ send_real: true }) })
    const user = userEvent.setup()
    renderApp('/settings/connections')

    await user.type(await within(await screen.findByRole('region', { name: 'Tester la Toolbox' })).findByLabelText('Adresse de test'), 'moi@circoe.com')
    await user.click(within(card()).getByRole('switch', { name: 'Envoyer pour de vrai' }))
    const delay = within(card()).getByLabelText('Envoi programmé dans (secondes)')
    await user.clear(delay)
    await user.type(delay, '90')
    await user.click(within(card()).getByRole('button', { name: 'Lancer le diagnostic' }))

    await waitFor(() => {
      expect(diagnostic.starts).toEqual([{ recipient: 'moi@circoe.com', send_real: true, delay_seconds: 90 }])
    })
  })

  it('shows a failed step open, with its code, hint, context and the raw Toolbox text', async () => {
    stub({
      diagnostic: run({
        steps: [
          step('list_baseline'),
          step('create', {
            status: 'failed',
            title: 'Créer un brouillon simple',
            context: { tool: 'infomaniak.mail.create_draft', to: 'test@circoe.com' },
            error: {
              code: 'toolbox_rejected',
              message: 'The Toolbox refused the operation (toolbox_rejected).',
              retryable: false,
              outcome_unknown: false,
              upstream_status: null,
              hint: 'Le texte exact de la Toolbox est dans l’échange brut.',
            },
            trace: [{ outcome: 'tool_error', text: 'Quota Infomaniak dépassé' }],
          }),
          step('find', { status: 'skipped', note: 'Étape précédente bloquante en échec.' }),
        ],
        verdict: {
          ok: false,
          counts: { ok: 1, failed: 1, skipped: 1 },
          problems: ['create'],
          first_problem: { step: 'create', title: 'Créer un brouillon simple', code: 'toolbox_rejected', hint: 'Voir l’échange brut.' },
        },
      }),
    })
    renderApp('/settings/connections')

    expect(await within(await screen.findByRole('region', { name: 'Tester la Toolbox' })).findByText('Problème détecté')).toBeInTheDocument()
    expect(card()).toHaveTextContent('Premier problème : « Créer un brouillon simple » (toolbox_rejected)')
    expect(card()).toHaveTextContent('Piste : Le texte exact de la Toolbox est dans l’échange brut.')
    expect(card()).toHaveTextContent('infomaniak.mail.create_draft')
    expect(card()).toHaveTextContent('Quota Infomaniak dépassé')
    expect(card()).toHaveTextContent('Dernier test en échec')
  })

  it('says when a test is already running', async () => {
    stub({ diagnosticRefusal: 409 })
    const user = userEvent.setup()
    renderApp('/settings/connections')

    await user.type(await within(await screen.findByRole('region', { name: 'Tester la Toolbox' })).findByLabelText('Adresse de test'), 'test@circoe.com')
    await user.click(within(card()).getByRole('button', { name: 'Lancer le diagnostic' }))

    expect(await within(card()).findByRole('alert')).toHaveTextContent('un test est déjà en cours')
  })
})
