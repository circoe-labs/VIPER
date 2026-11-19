import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'

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

// The category's visual identity on a card (`GET /api/missions`): icon key (see ui/icons), `#rrggbb` colour. Slice 05
// renders it; the previous id-hashed accent stays until then.
export interface MissionCategoryRef {
  id: string
  key: string | null
  name: string
  icon: string
  color: string
}

export interface SkillRef {
  id: string
  name: string
}

// Which category-derived fields a mission still follows (`prompt`, `skills`).
export interface MissionInheritance {
  category_id: string | null
  overridden_fields: string[]
  prompt_inherited: boolean
  skills_inherited: boolean
  category_prompt: string | null
  category_skills: SkillRef[]
  // Slice 02: false once the mission has its own external-source list.
  sources_inherited?: boolean
  category_sources?: { id: string; url: string; label: string | null }[]
}

// An agent working on the mission right now (active session), with the person it acts for.
export interface LiveAgentRef {
  agent_id: string
  agent_label: string
  owner_name: string | null
}

export interface MissionCard {
  id: string
  name: string
  type: MissionType
  // Optional in the type so older fixtures compile; the API always sends it (null only for a legacy row).
  category?: MissionCategoryRef | null
  status: MissionStatus
  // The permanent « Dépôt » mission: where agents drop spontaneous work. Never edited, paused, run or deleted.
  is_deposit: boolean
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
  // Only the list fills it; absent in older fixtures.
  live_agents?: LiveAgentRef[]
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

// An external library entry (Slice 02): a root (`parent_id` null) or one sub-level.
// `successful_uses` counts accepted items it supported (never visits); `rolled_up_uses` adds its sub-sources'.
export interface MissionSource {
  id: string
  url: string
  label: string | null
  description?: string | null
  domain?: string
  path_prefix?: string
  parent_id?: string | null
  children_count?: number
  successful_uses?: number
  rolled_up_uses?: number
  missions_count: number
  categories_count?: number
  created_at?: string | null
}

// A VIPER record linked as read-only context (Slice 02). Not a target and not evidence.
export interface MissionContextRef {
  kind: 'company' | 'prospect' | 'warehouse'
  id: string
  label: string
  hint: string | null
  note: string | null
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
  // Slice 04: one item per submission (false) or a list; the per-run goal.
  allow_multiple?: boolean
  objective?: MissionObjective
}

// `tasks_accepted`: every task of the run is accepted. `accepted_items`: `count` accepted items (<= result_limit).
export interface MissionObjective {
  kind: 'tasks_accepted' | 'accepted_items'
  count: number | null
}

export interface ObjectiveProgress {
  kind: string
  target: number | null
  current: number
  met: boolean
}

export interface MissionDetail {
  card: MissionCard
  targets: MissionTargetRow[]
  // The external sources the mission works with (its own list, else its category's defaults).
  sources: MissionSource[]
  context_refs?: MissionContextRef[]
  runs: MissionRunRow[]
  tasks: MissionTaskRow[]
  prompt: string
  result_kind: MissionResultKind
  result_limit: number
  rule: MissionRule
  inheritance?: MissionInheritance
  // The instruction skills the mission works with (its own list when overridden, else its category's).
  skills?: SkillRef[]
  objective_progress?: ObjectiveProgress | null
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
  kind: 'company' | 'prospect' | 'warehouse'
  id: string
  label: string
  hint: string | null
}

export interface MissionInput {
  name: string
  type: MissionType
  // Slice 05: `category_id` picks the category; `prompt` / `skill_ids` null = follow it, a value = override.
  category_id?: string | null
  skill_ids?: string[] | null
  // null = follow the category's general prompt (the server copies it); a text = this mission's own consigne.
  prompt: string | null
  targets: { kind: 'company' | 'prospect'; id: string }[]
  // Slice 02: null = follow the category's default sources, a list (possibly empty) = override.
  source_ids: string[] | null
  // Read-only internal records supplied as context (omitted on edit = kept).
  context_refs?: { kind: 'company' | 'prospect' | 'warehouse'; id: string; note?: string | null }[]
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
  allow_multiple?: boolean
  objective?: MissionObjective
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
  sources: ['missions', 'sources'] as const,
}

// `liveMs`: poll interval for the live part of the cards (paused by react-query while the tab is hidden).
export function useMissions(status?: MissionStatus, liveMs?: number) {
  return useQuery({
    queryKey: missionKeys.list(status),
    queryFn: ({ signal }) =>
      apiGet<MissionList>(`/missions${status ? `?status=${status}` : ''}`, signal),
    refetchInterval: liveMs,
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

// The saved links, reusable by any mission.
export function useMissionSources() {
  return useQuery({
    queryKey: missionKeys.sources,
    queryFn: ({ signal }) => apiGet<MissionSource[]>('/missions/sources', signal),
    refetchOnWindowFocus: false,
  })
}

// Saves a link once (the same link again returns the saved one).
export function useAddMissionSource() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (input: { url: string; label: string | null }) =>
      apiRequest<MissionSource>('POST', '/missions/sources', { body: input }),
    onSuccess: () => refreshAfterWrite(queryClient, [missionKeys.sources]),
  })
}

export function useDeleteMissionSource() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => apiRequest<undefined>('DELETE', `/missions/sources/${encodeURIComponent(id)}`),
    onSuccess: () => refreshAfterWrite(queryClient, [missionKeys.sources, ['missions']]),
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

// Changes only the external sources of a mission (PATCH): null = follow the category's defaults, a list = the mission's
// own (`[]` = no source at all). The answer is the fresh detail, so the page updates without a reload.
export function useUpdateMissionSources(id: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (sourceIds: string[] | null) =>
      apiRequest<MissionDetail>('PATCH', `/missions/${encodeURIComponent(id)}`, { body: { source_ids: sourceIds } }),
    onSuccess: (detail) => {
      queryClient.setQueryData(missionKeys.detail(id), detail)
      // The save is done once the server answered: the lists refresh behind it, they do not keep the editor waiting.
      void refreshAfterWrite(queryClient, [['missions']])
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


// --- Mission supervision (read-only): Overview, Activity, Results, Statistics ---------------------
// Mirrors backend/app/api/routes/mission_supervision.py and doc/architecture/mission-telemetry.md §8.
// Nothing here writes or touches an agent session; a result is still opened and decided through the
// existing review endpoints. Keys sit under ['missions', id, ...] so a mission write refreshes them.

export const AGENT_SESSION_STATUSES = ['active', 'ended', 'timed_out'] as const
export type AgentSessionStatus = (typeof AGENT_SESSION_STATUSES)[number]

export const SESSION_DISCONNECT_REASONS = [
  'agent_ended',
  'run_finished',
  'mission_cancelled',
  'inactivity_timeout',
] as const
export type SessionDisconnectReason = (typeof SESSION_DISCONNECT_REASONS)[number]

export const ACTIVITY_EVENT_TYPES = [
  'search',
  'source_opened',
  'observation',
  'verification',
  'progress',
  'warning',
  'error',
  'decision_summary',
] as const
export type ActivityEventType = (typeof ACTIVITY_EVENT_TYPES)[number]

export const RESULT_STATUSES = ['pending_review', 'accepted', 'rejected', 'superseded'] as const
export type MissionResultStatus = (typeof RESULT_STATUSES)[number]

export interface MissionRunSummary {
  id: string
  status: MissionRunStatus
  scheduled_at: string
  started_at: string | null
  finished_at: string | null
  tasks_total: number
  results_count: number
}

export interface LiveAgent {
  agent_id: string
  agent_label: string
  session_id: string
  run_id: string
  started_at: string
  last_seen_at: string
}

export interface MissionWarning {
  // sessions_timed_out | tasks_failed | no_active_agent
  code: string
  message: string
  count: number
}

export interface MissionOverview {
  mission_id: string
  name: string
  status: MissionStatus
  next_run_at: string | null
  current_run: MissionRunSummary | null
  active_sessions: number
  active_agents: number
  // Live agents (active sessions), most recently seen first, at most 50.
  agents: LiveAgent[]
  // Newest of session activity, log and result submission; null when nothing happened yet.
  last_activity_at: string | null
  tasks: { total: number; finished: number; by_status: Record<TaskStatus, number> }
  pending_reviews: number
  warnings: MissionWarning[]
}

export interface AgentSession {
  id: string
  run_id: string
  agent_id: string
  agent_label: string
  status: AgentSessionStatus
  started_at: string
  last_seen_at: string
  ended_at: string | null
  disconnect_reason: SessionDisconnectReason | null
  logs_count: number
}

export interface Page<T> {
  items: T[]
  total: number
  limit: number
  offset: number
}

export type AgentSessionPage = Page<AgentSession>

export interface ActivityEntry {
  id: string
  session_id: string
  run_id: string
  task_id: string | null
  agent_id: string
  agent_label: string
  session_status: AgentSessionStatus
  event_type: ActivityEventType
  message: string
  source_url: string | null
  // The source's own stated date; null = unknown (never the retrieval date).
  source_published_at: string | null
  created_at: string
  metadata: Record<string, unknown>
}

// Newest first. Older page: pass `before = next_cursor`; null = no older entry.
export interface ActivityPage {
  items: ActivityEntry[]
  next_cursor: string | null
}

export interface MissionResultCard {
  id: string
  task_id: string
  run_id: string
  task_type: TaskType
  status: MissionResultStatus
  agent_id: string | null
  agent_label: string
  subject_label: string | null
  summary: string | null
  // Global confidence 0-100; null when the result carries none (historical results).
  confidence: number | null
  items_count: number
  refused_count: number
  sources_count: number
  submitted_at: string
  decided_at: string | null
  decided_by: string | null
}

export interface MissionResultPage extends Page<MissionResultCard> {
  // Count per status ignoring the `status` filter (for the tab badges).
  status_counts: Record<MissionResultStatus, number>
}

export type StatsBucket = 'day' | 'hour'

export type ResultsSeriesPoint = Record<MissionResultStatus, number> & { bucket: string }

export interface CountSeriesPoint {
  bucket: string
  count: number
}

export interface AgentStats {
  agent_id: string
  agent_label: string
  sessions: number
  logs: number
  results: number
  accepted: number
  rejected: number
  pending_review: number
}

export interface MissionStatistics {
  bucket: StatsBucket
  days: number
  since: string
  until: string
  // Totals cover the whole mission; the series cover the last `days`, zero-filled per bucket.
  results_by_status: Record<MissionResultStatus, number>
  tasks_by_status: Record<TaskStatus, number>
  sessions_by_status: Record<AgentSessionStatus, number>
  logs_by_event_type: Record<ActivityEventType, number>
  results_series: ResultsSeriesPoint[]
  sessions_series: CountSeriesPoint[]
  logs_series: CountSeriesPoint[]
  decided_count: number
  // accepted / (accepted + rejected); null until a result is decided.
  acceptance_rate: number | null
  avg_review_seconds: number | null
  agents: AgentStats[]
}

export interface SessionsFilters {
  run_id?: string
  status?: AgentSessionStatus[]
  agent_id?: string
  limit?: number
  offset?: number
}

export interface ActivityFilters {
  run_id?: string
  session_id?: string
  agent_id?: string
  task_id?: string
  event_type?: ActivityEventType[]
  since?: string
  before?: string
  limit?: number
}

export interface ResultsFilters {
  status?: MissionResultStatus[]
  agent_id?: string
  run_id?: string
  limit?: number
  offset?: number
}

export interface StatisticsOptions {
  bucket?: StatsBucket
  // 1-90; at most 7 with hourly buckets.
  days?: number
}

function queryString(values: object): string {
  const params = new URLSearchParams()
  for (const [key, value] of Object.entries(values) as [string, string | number | string[] | undefined][]) {
    if (value === undefined) continue
    for (const item of Array.isArray(value) ? value : [value]) params.append(key, String(item))
  }
  const text = params.toString()
  return text ? `?${text}` : ''
}

export const supervisionKeys = {
  overview: (id: string) => ['missions', id, 'overview'] as const,
  sessions: (id: string, filters: SessionsFilters) => ['missions', id, 'sessions', filters] as const,
  activity: (id: string, filters: ActivityFilters) => ['missions', id, 'activity', filters] as const,
  results: (id: string, filters: ResultsFilters) => ['missions', id, 'results', filters] as const,
  statistics: (id: string, options: StatisticsOptions) =>
    ['missions', id, 'statistics', options] as const,
}

function missionPath(id: string, route: string): `/${string}` {
  return `/missions/${encodeURIComponent(id)}/${route}`
}

// `liveMs`: poll interval for a live tab (the first Activity page is polled and merged by `id`).
export function useMissionOverview(id: string | undefined, liveMs?: number) {
  return useQuery({
    queryKey: supervisionKeys.overview(id ?? ''),
    queryFn: ({ signal }) => apiGet<MissionOverview>(missionPath(id ?? '', 'overview'), signal),
    enabled: Boolean(id),
    refetchInterval: liveMs,
    refetchOnWindowFocus: false,
  })
}

export function useMissionSessions(id: string | undefined, filters: SessionsFilters = {}, liveMs?: number) {
  return useQuery({
    queryKey: supervisionKeys.sessions(id ?? '', filters),
    queryFn: ({ signal }) =>
      apiGet<AgentSessionPage>(missionPath(id ?? '', `sessions${queryString(filters)}`), signal),
    enabled: Boolean(id),
    refetchInterval: liveMs,
    refetchOnWindowFocus: false,
  })
}

export function useMissionActivity(
  id: string | undefined,
  filters: ActivityFilters = {},
  liveMs?: number,
) {
  return useQuery({
    queryKey: supervisionKeys.activity(id ?? '', filters),
    queryFn: ({ signal }) =>
      apiGet<ActivityPage>(missionPath(id ?? '', `activity${queryString(filters)}`), signal),
    enabled: Boolean(id),
    refetchInterval: liveMs,
    refetchOnWindowFocus: false,
  })
}

export function useMissionResults(id: string | undefined, filters: ResultsFilters = {}) {
  return useQuery({
    queryKey: supervisionKeys.results(id ?? '', filters),
    queryFn: ({ signal }) =>
      apiGet<MissionResultPage>(missionPath(id ?? '', `results${queryString(filters)}`), signal),
    enabled: Boolean(id),
    refetchOnWindowFocus: false,
  })
}

export function useMissionStatistics(id: string | undefined, options: StatisticsOptions = {}) {
  return useQuery({
    queryKey: supervisionKeys.statistics(id ?? '', options),
    queryFn: ({ signal }) =>
      apiGet<MissionStatistics>(missionPath(id ?? '', `statistics${queryString(options)}`), signal),
    enabled: Boolean(id),
    refetchOnWindowFocus: false,
    // New bucket/range: the previous figures stay (their headings name their own bucket/days) until the new ones land.
    placeholderData: keepPreviousData,
  })
}
