import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'

import type { TaskStatus, TaskType } from './agents'
import { apiGet, apiRequest } from './client'
import { refreshAfterWrite } from './refresh'

// Mirrors backend/app/api/routes/missions.py. A mission is the persistent rule; a run is one
// execution; the tasks of a run are claimed by agents over MCP and reviewed here.

export const MISSION_TYPES = ['prospection', 'signals', 'enrichment', 'verification', 'other'] as const
export type MissionType = (typeof MISSION_TYPES)[number]

export const MISSION_STATUSES = ['active', 'paused', 'done', 'cancelled'] as const
export type MissionStatus = (typeof MISSION_STATUSES)[number]

export const RUN_STATUSES = ['scheduled', 'running', 'done', 'failed', 'cancelled'] as const
export type MissionRunStatus = (typeof RUN_STATUSES)[number]

export const RESULT_KINDS = ['companies', 'prospects', 'signals', 'enrichment'] as const
export type MissionResultKind = (typeof RESULT_KINDS)[number]

export const RECURRENCE_UNITS = ['hours', 'days', 'weeks', 'months'] as const
export type RecurrenceUnit = (typeof RECURRENCE_UNITS)[number]

export const END_KINDS = ['never', 'date', 'after'] as const
export type MissionEndKind = (typeof END_KINDS)[number]

export interface MissionCard {
  id: string
  name: string
  type: MissionType
  status: MissionStatus
  agent_label: string | null
  prompt: string
  is_recurring: boolean
  interval_count: number
  interval_unit: RecurrenceUnit
  targets_count: number
  runs_count: number
  last_run_at: string | null
  last_run_status: MissionRunStatus | null
  last_run_results: number
  next_run_at: string | null
  tasks_total: number
  tasks_done: number
  results_pending: number
  created_at: string
}

export interface MissionTaskRow {
  id: string
  type: TaskType
  status: TaskStatus
  company_id: string | null
  prospect_id: string | null
  prospect_name: string | null
  claimed_by_label: string | null
  assigned_agent_id: string | null
  attempts: number
  max_attempts: number
  result_id: string | null
  submitted_at: string | null
}

export interface MissionRunRow {
  id: string
  status: MissionRunStatus
  trigger: 'manual' | 'schedule'
  scheduled_at: string
  started_at: string | null
  finished_at: string | null
  tasks_total: number
  results_count: number
  note: string | null
}

export interface MissionTargetRow {
  kind: 'company' | 'prospect'
  id: string
  label: string
  hint: string | null
}

export interface MissionProposal {
  result_id: string
  task_type: TaskType
  submitted_by_label: string
  submitted_at: string
  subject_label: string | null
}

// The rest of the rule, for « Modifier la mission » (the card holds the visible part).
export interface MissionRule {
  agent_id: string | null
  starts_at: string | null
  end_kind: MissionEndKind
  ends_at: string | null
  max_runs: number | null
  geography: string | null
  period_days: number | null
  exclusions: Record<string, boolean | string[]>
}

export interface MissionDetail {
  card: MissionCard
  targets: MissionTargetRow[]
  runs: MissionRunRow[]
  tasks: MissionTaskRow[]
  prompt: string
  result_kind: MissionResultKind
  result_limit: number
  rule: MissionRule
}

export interface MissionList {
  items: MissionCard[]
  total: number
}

export interface MissionOption {
  value: string
  executable: boolean
}

export interface MissionOptions {
  types: MissionOption[]
  result_kinds: MissionOption[]
  units: RecurrenceUnit[]
  end_kinds: MissionEndKind[]
  result_limit_max: number
}

export interface AgentOption {
  id: string
  label: string
  scopes: string[]
}

export interface TargetOption {
  kind: 'company' | 'prospect'
  id: string
  label: string
  hint: string | null
}

export interface MissionInput {
  name: string
  type: MissionType
  prompt: string
  targets: { kind: 'company' | 'prospect'; id: string }[]
  agent_id: string | null
  is_recurring: boolean
  interval_count: number
  interval_unit: RecurrenceUnit
  starts_at: string | null
  end_kind: MissionEndKind
  ends_at: string | null
  max_runs: number | null
  result_kind: MissionResultKind
  result_limit: number
  geography: string | null
  period_days: number | null
  exclusions: Record<string, boolean | string[]>
  run_now: boolean
}

export const missionKeys = {
  all: ['missions'] as const,
  list: (status?: MissionStatus) => ['missions', 'list', status ?? 'all'] as const,
  detail: (id: string) => ['missions', 'detail', id] as const,
  options: ['missions', 'options'] as const,
  agents: ['missions', 'agents'] as const,
  targets: (kind: string, search: string) => ['missions', 'targets', kind, search] as const,
  proposals: ['missions', 'proposals'] as const,
}

export function useMissions(status?: MissionStatus) {
  return useQuery({
    queryKey: missionKeys.list(status),
    queryFn: ({ signal }) =>
      apiGet<MissionList>(`/missions${status ? `?status=${status}` : ''}`, signal),
    refetchOnWindowFocus: false,
  })
}

export function useMission(id: string | undefined) {
  return useQuery({
    queryKey: missionKeys.detail(id ?? ''),
    queryFn: ({ signal }) => apiGet<MissionDetail>(`/missions/${encodeURIComponent(id ?? '')}`, signal),
    enabled: Boolean(id),
    refetchOnWindowFocus: false,
  })
}

export function useMissionProposals() {
  return useQuery({
    queryKey: missionKeys.proposals,
    queryFn: ({ signal }) => apiGet<MissionProposal[]>('/missions/proposals', signal),
    refetchOnWindowFocus: false,
  })
}

export function useMissionOptions() {
  return useQuery({
    queryKey: missionKeys.options,
    queryFn: ({ signal }) => apiGet<MissionOptions>('/missions/options', signal),
    staleTime: Infinity,
  })
}

export function useMissionAgents() {
  return useQuery({
    queryKey: missionKeys.agents,
    queryFn: ({ signal }) => apiGet<AgentOption[]>('/missions/agents', signal),
    staleTime: 60_000,
  })
}

export function useMissionTargets(kind: 'company' | 'prospect', search: string, enabled: boolean) {
  return useQuery({
    queryKey: missionKeys.targets(kind, search),
    queryFn: ({ signal }) =>
      apiGet<TargetOption[]>(
        `/missions/targets?kind=${kind}&limit=20${search ? `&q=${encodeURIComponent(search)}` : ''}`,
        signal,
      ),
    enabled,
    refetchOnWindowFocus: false,
  })
}

export function useCreateMission() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (input: MissionInput) =>
      apiRequest<MissionDetail>('POST', '/missions', { body: input }),
    onSuccess: () => refreshAfterWrite(queryClient, [['missions']]),
  })
}

export function useSetMissionStatus(id: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (status: MissionStatus) =>
      apiRequest<MissionDetail>('PATCH', `/missions/${encodeURIComponent(id)}`, { body: { status } }),
    onSuccess: () => refreshAfterWrite(queryClient, [['missions'], missionKeys.detail(id)]),
  })
}

// « Modifier la mission »: the whole rule, linked data included; runs already made stay as they are.
export function useUpdateMission(id: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (input: MissionInput) =>
      apiRequest<MissionDetail>('PUT', `/missions/${encodeURIComponent(id)}`, { body: input }),
    onSuccess: (detail) => {
      queryClient.setQueryData(missionKeys.detail(id), detail)
      return refreshAfterWrite(queryClient, [['missions']])
    },
  })
}

// « Supprimer la mission »: the server cancels its open agent tasks, then deletes it with its targets and runs.
export function useDeleteMission(id: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: () => apiRequest<undefined>('DELETE', `/missions/${encodeURIComponent(id)}`),
    onSuccess: () => {
      queryClient.removeQueries({ queryKey: missionKeys.detail(id) })
      // Its cancelled tasks leave the Agents queue and review cards.
      return refreshAfterWrite(queryClient, [['missions'], ['agents']])
    },
  })
}

