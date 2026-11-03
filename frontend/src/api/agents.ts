import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'

import { apiGet, apiRequest } from './client'
import { refreshAfterWrite } from './refresh'

// Mirrors the agents routes of backend/app/api/routes/agents.py: an « Analyse » thread groups tasks an agent
// claims over MCP, and a person organises the queue from here. Design: doc/architecture/agent-missions.md.

export const THREAD_STATUSES = ['open', 'paused', 'done', 'cancelled'] as const
export type ThreadStatus = (typeof THREAD_STATUSES)[number]

export const TASK_STATUSES = ['pending', 'claimed', 'submitted', 'accepted', 'failed', 'cancelled'] as const
export type TaskStatus = (typeof TASK_STATUSES)[number]

export const TASK_TYPES = [
  'update_company',
  'update_employee',
  'find_employees',
  'surveil_signals',
  'find_prospects',
] as const
export type TaskType = (typeof TASK_TYPES)[number]

export type ThreadKind = 'company_review' | 'prospect_search'

export interface ThreadCard {
  id: string
  kind: ThreadKind
  title: string
  status: ThreadStatus
  company_id: string | null
  company_name: string | null
  tasks_total: number
  tasks_done: number
  tasks_pending: number
  tasks_claimed: number
  tasks_submitted: number
  tasks_failed: number
  agents: string[]
  last_activity_at: string | null
  created_at: string
}

export interface TaskRow {
  id: string
  type: TaskType
  status: TaskStatus
  priority: number
  attempts: number
  max_attempts: number
  company_id: string | null
  prospect_id: string | null
  prospect_name: string | null
  claimed_by_label: string | null
  claimed_at: string | null
  lease_expires_at: string | null
  failure_code: string | null
  result_id: string | null
  submitted_at: string | null
  created_at: string
}

export interface ThreadDetail {
  thread: ThreadCard
  tasks: TaskRow[]
}

export interface ThreadList {
  items: ThreadCard[]
  total: number
}

export interface ProposalItem {
  key: string
  field: string
  label: string
  before: unknown
  after: unknown
  status: 'add' | 'change'
  source: string | null
  quote: string | null
  // Signals carry their own fields (kind, subject, observed_on, score, relevance) here.
  store?: Record<string, unknown>
}

export interface ProposalRefused {
  field: string
  label: string
  reason: string
  message: string
}

export interface Proposal {
  kind: string
  items: ProposalItem[]
  refused: ProposalRefused[]
  stale: boolean
  confidence: number
  notes: string | null
}

export interface ResultView {
  id: string
  task_id: string
  task_type: TaskType
  task_status: TaskStatus
  status: 'pending_review' | 'accepted' | 'rejected' | 'superseded'
  submitted_at: string
  submitted_by_label: string
  digest: string
  proposal: Proposal
  accepted_items: { keys: string[] } | null
  applied: { fields?: string[] } | null
  decision_note: string | null
  decided_at: string | null
  decided_by_display: string | null
  company_name: string | null
  prospect_name: string | null
}

export const agentKeys = {
  threads: () => ['agents', 'threads'] as const,
  thread: (id: string) => ['agents', 'threads', id] as const,
}

export function useThreads() {
  return useQuery({
    queryKey: agentKeys.threads(),
    queryFn: ({ signal }) => apiGet<ThreadList>('/agents/threads', signal),
    refetchOnWindowFocus: false,
  })
}

export function useThread(id: string | undefined) {
  return useQuery({
    queryKey: agentKeys.thread(id ?? ''),
    queryFn: ({ signal }) => apiGet<ThreadDetail>(`/agents/threads/${encodeURIComponent(id ?? '')}`, signal),
    enabled: Boolean(id),
    refetchOnWindowFocus: false,
  })
}

export function useOpenThread() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (companyId: string) =>
      apiRequest<ThreadDetail>('POST', '/agents/threads', { body: { company_id: companyId } }),
    onSuccess: () => refreshAfterWrite(queryClient, [agentKeys.threads()]),
  })
}

export function useSetThreadStatus(id: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (status: ThreadStatus) =>
      apiRequest<ThreadDetail>('PATCH', `/agents/threads/${encodeURIComponent(id)}`, { body: { status } }),
    onSuccess: () => refreshAfterWrite(queryClient, [agentKeys.threads(), agentKeys.thread(id)]),
  })
}

export function useResult(id: string | null) {
  return useQuery({
    queryKey: ['agents', 'results', id ?? ''],
    queryFn: ({ signal }) => apiGet<ResultView>(`/agents/results/${encodeURIComponent(id ?? '')}`, signal),
    enabled: Boolean(id),
    refetchOnWindowFocus: false,
  })
}

function refreshAgents(queryClient: ReturnType<typeof useQueryClient>) {
  return refreshAfterWrite(queryClient, [['agents']])
}

export function useAcceptResult(id: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (input: { accepted_items: string[]; note?: string }) =>
      apiRequest<ResultView>('POST', `/agents/results/${encodeURIComponent(id)}/accept`, { body: input }),
    onSuccess: () => refreshAgents(queryClient),
  })
}

export function useRejectResult(id: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (reason: string) =>
      apiRequest<ResultView>('POST', `/agents/results/${encodeURIComponent(id)}/reject`, { body: { reason } }),
    onSuccess: () => refreshAgents(queryClient),
  })
}
