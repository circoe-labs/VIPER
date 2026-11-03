import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'

import { apiGet, apiRequest } from './client'
import { refreshAfterWrite } from './refresh'

// Mirrors `GET /api/settings/mcp` (backend/app/api/routes/mcp_settings.py): the tools VIPER exposes to agents, as
// served by `app.api.mcp.TOOLS`. Read-only — the endpoint, the tools and their schemas live in code.

export interface McpParameter {
  name: string
  type: string
  required: boolean
  description: string | null
  enum: string[] | null
}

export interface McpTool {
  name: string
  description: string
  parameters: McpParameter[]
}

export interface McpSettings {
  endpoint: string
  protocol_version: string
  tools: McpTool[]
}

export function useMcpSettings() {
  return useQuery({
    queryKey: ['settings', 'mcp'],
    queryFn: ({ signal }) => apiGet<McpSettings>('/settings/mcp', signal),
    refetchOnWindowFocus: false,
  })
}

// « Accès autorisés » (`GET /api/settings/mcp/agents`): every agent credential, OAuth connectors included. Never a
// token, only its label and dates.
export interface McpAgent {
  id: string
  label: string
  // `oauth`: approved from a connector (ChatGPT, Claude…); `cli`: made in the command line.
  origin: 'oauth' | 'cli'
  created_at: string
  last_used_at: string | null
  revoked_at: string | null
}

export const mcpAgentsKey = ['settings', 'mcp', 'agents'] as const

export function useMcpAgents() {
  return useQuery({
    queryKey: mcpAgentsKey,
    queryFn: ({ signal }) => apiGet<McpAgent[]>('/settings/mcp/agents', signal),
  })
}

// « Révoquer »: the agent can no longer call /mcp, its OAuth tokens included.
export function useRevokeMcpAgent() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => apiRequest<McpAgent>('POST', `/settings/mcp/agents/${encodeURIComponent(id)}/revoke`),
    onSuccess: () => refreshAfterWrite(queryClient, [mcpAgentsKey, ['missions', 'agents']]),
  })
}
