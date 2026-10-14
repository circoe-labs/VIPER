import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'

import { apiGet, apiRequest } from './client'

// Mirrors backend/app/api/routes/integrations.py (« Tester la Toolbox »): a scripted run of every mail operation
// against a test address, started in the background and polled while it runs.

export type DiagnosticStepStatus = 'pending' | 'running' | 'ok' | 'failed' | 'expected_error' | 'unexpected' | 'skipped'

export interface DiagnosticError {
  code: string
  message: string
  retryable: boolean
  outcome_unknown: boolean
  upstream_status: number | null
  // What a person can do about this code (French).
  hint: string | null
  // What the Toolbox itself answered (its error text, JSON-RPC error or HTTP status), when it said anything.
  toolbox_text?: string | null
}

export interface DiagnosticStep {
  key: string
  title: string
  expectation: string
  status: DiagnosticStepStatus
  started_at: string | null
  duration_ms: number | null
  context: Record<string, unknown>
  observed: Record<string, unknown>
  error: DiagnosticError | null
  note: string | null
  // The raw HTTP / JSON-RPC exchange of the step, the Toolbox's own error text included.
  trace: Record<string, unknown>[]
}

export interface DiagnosticVerdict {
  ok: boolean
  counts: Partial<Record<DiagnosticStepStatus, number>>
  problems: string[]
  first_problem: { step: string; title: string; code: string | null; hint: string | null } | null
}

export interface Diagnostic {
  id: string
  recipient: string
  send_real: boolean
  delay_seconds: number
  started_at: string
  finished_at: string | null
  status: 'running' | 'done' | 'crashed'
  steps: DiagnosticStep[]
  verdict: DiagnosticVerdict | null
  crash: string | null
}

export interface DiagnosticRequest {
  recipient: string
  send_real: boolean
  delay_seconds: number
}

export const DIAGNOSTIC_DELAY = { min: 20, max: 300, default: 60 } as const
const POLL_MS = 1500

const key = ['toolbox', 'diagnostic'] as const

// The last run of this server (null before any). Polled while it runs, so the page follows it step by step.
export function useToolboxDiagnostic() {
  return useQuery({
    queryKey: key,
    queryFn: ({ signal }) => apiGet<Diagnostic | null>('/settings/integrations/toolbox/diagnostics/latest', signal),
    refetchInterval: (query) => (query.state.data?.status === 'running' ? POLL_MS : false),
  })
}

// « Effacer le résultat »: the server forgets the last run, the card goes back to its empty state.
export function useClearToolboxDiagnostic() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: () => apiRequest<undefined>('DELETE', '/settings/integrations/toolbox/diagnostics/latest'),
    onSuccess: () => {
      queryClient.setQueryData(key, null)
    },
  })
}

export function useStartToolboxDiagnostic() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (request: DiagnosticRequest) =>
      apiRequest<Diagnostic>('POST', '/settings/integrations/toolbox/diagnostics', { body: request }),
    onSuccess: (run) => {
      queryClient.setQueryData(key, run)
    },
  })
}
