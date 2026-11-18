import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'

import type { ProposalItem, ProposalRefused } from './agents'
import { apiGet, apiRequest } from './client'
import { prospectKeys } from './prospects'
import { refreshAfterWrite } from './refresh'

// Mirrors backend/app/api/routes/score_reassessment.py: « Réévaluer le score » asks an agent (a one-off mission bound
// to the prospect) for a commercial-fit proposal. The proposal is decided through the ordinary result review
// (ReviewDialog); only an accepted proposal changes the score. Contract: backend/app/services/score_reassessment.py.

export type ReassessmentStatus =
  | 'idle'
  | 'queued'
  | 'running'
  | 'proposal'
  | 'applied'
  | 'nothing_found'
  | 'rejected'
  | 'failed'
  | 'cancelled'

export interface ReassessmentProposal {
  kind: 'score_reassessment'
  items: ProposalItem[]
  refused: ProposalRefused[]
  rationale: string | null
  current_total: number
  projected_total: number
  agent_suggested_total: number | null
  confidence: number
  notes: string | null
}

export interface Reassessment {
  status: ReassessmentStatus
  task_id: string | null
  mission_id: string | null
  run_id: string | null
  result_id: string | null
  requested_at: string | null
  agent_label: string | null
  failure_code: string | null
  failure_message: string | null
  proposal: ReassessmentProposal | null
  decided_by: string | null
  decided_at: string | null
  // Live agents able to take the task (while queued/running): 0 = nobody is connected to pick it up.
  agents_available: number
}

// The statuses where an agent still has to answer: the card polls while one of them holds.
export const WAITING_STATUSES: readonly ReassessmentStatus[] = ['queued', 'running']
const POLL_MS = 5000

export const reassessmentKeys = {
  detail: (prospectId: string) => ['prospects', prospectId, 'score-reassessment'] as const,
}

function path(prospectId: string): `/${string}` {
  return `/prospects/${encodeURIComponent(prospectId)}/score/reassessment`
}

export function useScoreReassessment(prospectId: string | null | undefined) {
  return useQuery({
    queryKey: reassessmentKeys.detail(prospectId ?? ''),
    queryFn: ({ signal }) => apiGet<Reassessment>(path(prospectId ?? ''), signal),
    enabled: Boolean(prospectId),
    refetchInterval: (query) => (query.state.data && WAITING_STATUSES.includes(query.state.data.status) ? POLL_MS : false),
  })
}

// Asking (or cancelling) changes only the reassessment state; the score itself moves when a proposal is accepted
// (`refreshScore`, called by the card once the review closes).
export function useReassessmentCommands(prospectId: string) {
  const queryClient = useQueryClient()
  const store = (state: Reassessment) => {
    queryClient.setQueryData(reassessmentKeys.detail(prospectId), state)
  }
  const request = useMutation({
    mutationFn: (input: { instruction?: string }) =>
      apiRequest<Reassessment>('POST', path(prospectId), { body: { instruction: input.instruction ?? null } }),
    onSuccess: store,
  })
  const cancel = useMutation({
    mutationFn: () => apiRequest<Reassessment>('DELETE', path(prospectId)),
    onSuccess: store,
  })
  return { request, cancel }
}

// After a decision: the prospect (its score) and the reassessment state are read again.
export function refreshScore(queryClient: ReturnType<typeof useQueryClient>, prospectId: string): Promise<void> {
  return refreshAfterWrite(queryClient, [prospectKeys.detail(prospectId), ['agents'], ['missions']])
}
