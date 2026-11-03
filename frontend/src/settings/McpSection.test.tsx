import { screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import type { McpSettings } from '../api/mcpSettings'
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
    stubApi({ ...SHELL_API, 'GET /api/settings/mcp': [200, SETTINGS] })

    renderApp('/settings/mcp')

    expect(await screen.findByText('viper_claim_task')).toBeInTheDocument()
    expect(screen.getByText('viper_task_queue')).toBeInTheDocument()
    expect(screen.getByText('/mcp')).toBeInTheDocument()
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
})
