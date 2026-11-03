import { useQuery } from '@tanstack/react-query'

import { apiGet } from './client'

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
