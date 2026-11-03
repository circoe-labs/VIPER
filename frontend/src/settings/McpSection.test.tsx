import { screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'

import type { McpAgent, McpSettings } from '../api/mcpSettings'
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
    expect(within(access).getByText(/Connecteur OAuth/)).toBeInTheDocument()
    await user.click(within(access).getByRole('button', { name: 'Révoquer' }))
    await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Révoquer l’accès' }))

    expect(await within(access).findByText('Révoqué')).toBeInTheDocument()
    expect(revoked).toBe(true)
  })
})
