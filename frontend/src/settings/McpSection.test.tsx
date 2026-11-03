import { screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'

import type { McpAgent, McpCall, McpSettings } from '../api/mcpSettings'
import { SHELL_API } from '../test/homeApi'
import { renderApp, stubApi } from '../test/render'

const SETTINGS: McpSettings = {
  endpoint: '/mcp',
  protocol_version: '2025-06-18',
  tools: [
    {
      name: 'viper_claim_task',
      description: 'Claim the next task matching this token’s scopes.',
      parameters: [
        {
          name: 'task_types',
          type: 'liste de string',
          required: false,
          description: 'Restrict to these types; the token’s scopes still apply.',
          enum: ['update_company', 'update_employee'],
        },
        { name: 'thread_id', type: 'string', required: false, description: null, enum: null },
      ],
    },
    {
      name: 'viper_task_queue',
      description: 'How many tasks of each allowed type are waiting.',
      parameters: [],
    },
  ],
  capabilities: [
    { name: 'tasks.work', label: 'Traiter les tâches de mission (prendre, rendre, soumettre)' },
    { name: 'records.read', label: 'Lire les entreprises et les personnes' },
    { name: 'missions.cancel', label: 'Annuler et supprimer une mission' },
  ],
  mode_defaults: {
    worker: ['tasks.work', 'records.read'],
    interactive: ['tasks.work', 'records.read', 'missions.cancel'],
    scheduled: ['records.read'],
  },
  grantable: ['tasks.work', 'records.read', 'missions.cancel'],
}

describe('McpSection', () => {
  it('lists the exposed tools with their parameters and the endpoint', async () => {
    stubApi({ ...SHELL_API, 'GET /api/settings/mcp': [200, SETTINGS], 'GET /api/settings/mcp/agents': [200, []] })

    renderApp('/settings/mcp')

    expect(await screen.findByText('viper_claim_task')).toBeInTheDocument()
    expect(screen.getByText('viper_task_queue')).toBeInTheDocument()
    expect(screen.getByText(`${window.location.origin}/mcp`)).toBeInTheDocument()
    // A parameter, its type, the enum inside the array, and the "no parameter" case.
    expect(screen.getByText('task_types')).toBeInTheDocument()
    expect(screen.getByText('liste de string')).toBeInTheDocument()
    expect(screen.getByText(/update_company/)).toBeInTheDocument()
    expect(screen.getByText('aucun paramètre')).toBeInTheDocument()
  })

  it('says when the tools cannot be loaded', async () => {
    stubApi({ ...SHELL_API, 'GET /api/settings/mcp': [500, { detail: 'boom' }] })

    renderApp('/settings/mcp')

    expect(await screen.findByText('Les outils MCP n’ont pas pu être chargés.')).toBeInTheDocument()
  })

  it('lists who may connect and revokes an access after a confirmation', async () => {
    const agent: McpAgent = {
      id: '00000000-0000-7000-a000-000000000001',
      label: 'ChatGPT (OAuth)',
      origin: 'oauth',
      owner_email: 'pilote.test@circoe.com',
      provider: 'chatgpt',
      mode: 'interactive',
      capabilities: ['records.read'],
      created_at: '2026-11-03T10:00:00+00:00',
      last_used_at: '2026-11-03T11:00:00+00:00',
      revoked_at: null,
    }
    let revoked = false
    stubApi({
      ...SHELL_API,
      'GET /api/settings/mcp': [200, SETTINGS],
      'GET /api/settings/mcp/agents': () => [200, [revoked ? { ...agent, revoked_at: '2026-11-03T12:00:00+00:00' } : agent]],
      [`POST /api/settings/mcp/agents/${agent.id}/revoke`]: () => {
        revoked = true
        return [200, { ...agent, revoked_at: '2026-11-03T12:00:00+00:00' }]
      },
    })
    const user = userEvent.setup()

    renderApp('/settings/mcp')
    const access = await screen.findByRole('region', { name: 'Accès autorisés' })
    expect(await within(access).findByText('ChatGPT (OAuth)')).toBeInTheDocument()
    expect(within(access).getByText(/Connecteur OAuth · ChatGPT · Assistant \(agit pour vous\)/)).toBeInTheDocument()
    expect(within(access).getByText('Lire les entreprises et les personnes')).toBeInTheDocument()
    await user.click(within(access).getByRole('button', { name: 'Révoquer' }))
    await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Révoquer l’accès' }))

    expect(await within(access).findByText('Révoqué')).toBeInTheDocument()
    expect(revoked).toBe(true)
  })

  it('creates a token with its mode and capabilities and shows it once', async () => {
    const created = {
      id: 'a-9',
      label: 'Worker nuit',
      origin: 'cli',
      owner_email: 'pilote.test@circoe.com',
      provider: 'claude',
      mode: 'worker',
      capabilities: ['tasks.work'],
      created_at: '2026-11-03T10:00:00+00:00',
      last_used_at: null,
      revoked_at: null,
    }
    const fetchMock = stubApi({
      ...SHELL_API,
      'GET /api/settings/mcp': [200, SETTINGS],
      'GET /api/settings/mcp/agents': [200, []],
      'POST /api/settings/mcp/agents': [201, { token: 'viper_secret-token', agent: created }],
    })
    const user = userEvent.setup()

    renderApp('/settings/mcp')
    const access = await screen.findByRole('region', { name: 'Accès autorisés' })
    await user.click(within(access).getByRole('button', { name: 'Créer un jeton' }))
    const dialog = await screen.findByRole('dialog')
    await user.type(within(dialog).getByLabelText(/Nom/), 'Worker nuit')
    await user.selectOptions(within(dialog).getByLabelText('Plateforme'), 'claude')
    // The worker defaults are checked; one of them is unchecked.
    expect(within(dialog).getByLabelText('Annuler et supprimer une mission')).not.toBeChecked()
    await user.click(within(dialog).getByLabelText('Lire les entreprises et les personnes'))
    await user.click(within(dialog).getByRole('button', { name: 'Créer le jeton' }))

    expect(await screen.findByText('viper_secret-token')).toBeInTheDocument()
    const post = fetchMock.mock.calls.find(([, init]) => init?.method === 'POST')
    expect(JSON.parse(post?.[1]?.body as string)).toEqual({
      label: 'Worker nuit',
      provider: 'claude',
      mode: 'worker',
      capabilities: ['tasks.work'],
    })
  })

  it('says when the role does not allow a capability', async () => {
    stubApi({
      ...SHELL_API,
      'GET /api/settings/mcp': [200, SETTINGS],
      'GET /api/settings/mcp/agents': [200, []],
      'POST /api/settings/mcp/agents': [403, { detail: { code: 'forbidden', message: 'Your role may not grant.' } }],
    })
    const user = userEvent.setup()

    renderApp('/settings/mcp')
    const access = await screen.findByRole('region', { name: 'Accès autorisés' })
    await user.click(within(access).getByRole('button', { name: 'Créer un jeton' }))
    const dialog = await screen.findByRole('dialog')
    await user.type(within(dialog).getByLabelText(/Nom/), 'Worker')
    await user.click(within(dialog).getByRole('button', { name: 'Créer le jeton' }))

    expect(await within(dialog).findByRole('alert')).toHaveTextContent('Votre rôle ne permet pas')
  })

  it('offers only what the role allows, so a member’s assistant is created as it is', async () => {
    const member: McpSettings = { ...SETTINGS, grantable: ['tasks.work', 'records.read'] }
    const fetchMock = stubApi({
      ...SHELL_API,
      'GET /api/settings/mcp': [200, member],
      'GET /api/settings/mcp/agents': [200, []],
      'POST /api/settings/mcp/agents': [403, { detail: { code: 'forbidden', message: 'Your role may not grant.' } }],
    })
    const user = userEvent.setup()

    renderApp('/settings/mcp')
    const access = await screen.findByRole('region', { name: 'Accès autorisés' })
    await user.click(within(access).getByRole('button', { name: 'Créer un jeton' }))
    const dialog = await screen.findByRole('dialog')
    await user.type(within(dialog).getByLabelText(/Nom/), 'ChatGPT')
    await user.selectOptions(within(dialog).getByLabelText('Mode'), 'interactive')

    const cancel = within(dialog).getByLabelText('Annuler et supprimer une mission')
    expect(cancel).not.toBeChecked()
    expect(cancel).toBeDisabled()
    expect(within(dialog).getByText('Votre rôle ne permet pas de l’accorder.')).toBeInTheDocument()
    await user.click(within(dialog).getByRole('button', { name: 'Créer le jeton' }))
    const post = fetchMock.mock.calls.find(([, init]) => init?.method === 'POST')
    expect(JSON.parse(post?.[1]?.body as string)).toMatchObject({
      mode: 'interactive',
      capabilities: ['tasks.work', 'records.read'],
    })
  })

  it('shows who called which tool, filters by person and opens the detail', async () => {
    const calls: McpCall[] = [
      {
        id: 'c-2',
        created_at: '2026-11-03T21:00:00Z',
        user_email: 'paul@circoe.com',
        agent: 'ChatGPT (OAuth)',
        agent_id: 'a-2',
        tool: 'viper_get_company',
        arguments: { company_id: 'inconnue' },
        outcome: 'refused',
        error_code: 'not_found',
        error_message: 'Unknown company.',
        duration_ms: 12,
      },
      {
        id: 'c-1',
        created_at: '2026-11-03T20:00:00Z',
        user_email: 'marie@circoe.com',
        agent: 'Claude (OAuth)',
        agent_id: 'a-1',
        tool: 'viper_list_companies',
        arguments: { search: 'entrepôt' },
        outcome: 'ok',
        error_code: null,
        error_message: null,
        duration_ms: 40,
      },
    ]
    const requested: string[] = []
    stubApi({
      ...SHELL_API,
      'GET /api/settings/mcp': [200, SETTINGS],
      'GET /api/settings/mcp/agents': [200, []],
      'GET /api/settings/mcp/calls': (url) => {
        requested.push(url.search)
        const email = url.searchParams.get('email')
        return [
          200,
          {
            calls: email ? calls.filter((call) => call.user_email === email) : calls,
            emails: ['marie@circoe.com', 'paul@circoe.com'],
            tools: ['viper_get_company', 'viper_list_companies'],
            has_more: false,
          },
        ]
      },
    })

    renderApp('/settings/mcp')

    const table = await screen.findByRole('table', { name: 'Historique des appels MCP' })
    expect(within(table).getByText('paul@circoe.com')).toBeInTheDocument()
    expect(within(table).getByText('Refusé · not_found')).toBeInTheDocument()
    expect(within(table).getByText('search: entrepôt')).toBeInTheDocument()

    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Personne' }), 'marie@circoe.com')

    expect(await within(table).findByText('Claude (OAuth)')).toBeInTheDocument()
    expect(within(table).queryByText('paul@circoe.com')).not.toBeInTheDocument()
    expect(requested.at(-1)).toContain('email=marie%40circoe.com')
    await userEvent.click(within(table).getByRole('button', { name: 'Voir le détail' }))
    expect(within(table).getByText(/"search": "entrepôt"/)).toBeInTheDocument()
  })
})
