import { keepPreviousData, useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'

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
  // The person the agent acts for: its calls are kept under this address.
  owner_email: string | null
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

// « Historique des appels » (`GET /api/settings/mcp/calls`): who asked what on /mcp, newest first.
export interface McpCall {
  id: string
  created_at: string
  user_email: string | null
  agent: string
  agent_id: string | null
  tool: string
  // What the agent sent, long texts shortened by the server.
  arguments: unknown
  outcome: 'ok' | 'refused' | 'error'
  error_code: string | null
  error_message: string | null
  duration_ms: number
}

export interface McpCallsPage {
  calls: McpCall[]
  emails: string[]
  tools: string[]
  has_more: boolean
}

export const MCP_CALLS_PAGE_SIZE = 50

export function useMcpCalls(filters: { email: string; tool: string }) {
  return useInfiniteQuery({
    queryKey: ['settings', 'mcp', 'calls', filters],
    queryFn: ({ pageParam, signal }) => {
      const params = new URLSearchParams({ limit: String(MCP_CALLS_PAGE_SIZE) })
      if (filters.email) params.set('email', filters.email)
      if (filters.tool) params.set('tool', filters.tool)
      if (pageParam) params.set('before', pageParam)
      return apiGet<McpCallsPage>(`/settings/mcp/calls?${params.toString()}`, signal)
    },
    initialPageParam: null as string | null,
    getNextPageParam: (page) => (page.has_more ? (page.calls.at(-1)?.created_at ?? null) : null),
    // A new filter keeps the table on screen until its answer arrives.
    placeholderData: keepPreviousData,
  })
}
