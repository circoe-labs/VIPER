import { TASK_STATUS_LABELS } from '../agents/labels'
import type { TaskStatus } from '../api/agents'
import type { MissionOverview, MissionResultStatus, MissionStatistics } from '../api/missions'
import type { DonutInput } from './donutModel'
import type { MissionHue } from './missionAccent'
import { RESULT_STATUS_COUNT_LABELS } from './vocabulary'

// Deterministic selectors of the Statistiques tab (Slice 03). Pure: `MissionStatistics` / `MissionOverview` in, plain
// view models out. No React, no clock, no randomness, so every figure is unit-testable. Only mission-execution facts:
// there is NO tool/API-call counter in the telemetry (CONTRACT.md D3), so nothing here is, or is named, a « call ».
// Source fields and aggregation of each selector are tabulated in doc/architecture/mission-telemetry.md.

export interface ProgressModel {
  total: number
  // accepted + failed + cancelled (`MissionOverview.tasks.finished`): « traitées », not « validées ».
  finished: number
  remaining: number
  // 0-100 integer; null when the mission has no task (never 0 %).
  percent: number | null
}

export function progressOf(overview: MissionOverview): ProgressModel {
  const { total, finished } = overview.tasks
  return {
    total,
    finished,
    remaining: Math.max(total - finished, 0),
    percent: total > 0 ? Math.round((Math.min(finished, total) / total) * 100) : null,
  }
}

// Categorical order for agents (CONTRACT.md §2.5 rule 6): rank in the list, not an identity.
const AGENT_HUES: MissionHue[] = ['green', 'blue', 'amber', 'purple', 'teal', 'indigo']

// Journal entries per agent (`agents[].logs`), biggest first; agents with no entry are left out of the ring.
export function agentActivityDonut(stats: MissionStatistics): DonutInput[] {
  return stats.agents
    .filter((agent) => agent.logs > 0)
    .sort((a, b) => b.logs - a.logs || a.agent_label.localeCompare(b.agent_label, 'fr'))
    .map((agent, index) => ({
      key: agent.agent_id,
      label: agent.agent_label,
      value: agent.logs,
      hue: AGENT_HUES[index % AGENT_HUES.length] as MissionHue,
    }))
}

const RESULT_HUES: Record<MissionResultStatus, MissionHue> = {
  accepted: 'success',
  rejected: 'danger',
  pending_review: 'amber',
  superseded: 'neutral',
}

export function resultsDonut(stats: MissionStatistics): DonutInput[] {
  return (Object.keys(RESULT_HUES) as MissionResultStatus[]).map((status) => ({
    key: status,
    label: RESULT_STATUS_COUNT_LABELS[status],
    value: stats.results_by_status[status],
    hue: RESULT_HUES[status],
  }))
}

const TASK_HUES: Record<TaskStatus, MissionHue> = {
  accepted: 'success',
  claimed: 'blue',
  submitted: 'amber',
  pending: 'indigo',
  failed: 'danger',
  cancelled: 'neutral',
}

export function tasksDonut(stats: MissionStatistics): DonutInput[] {
  return (Object.keys(TASK_HUES) as TaskStatus[]).map((status) => ({
    key: status,
    label: TASK_STATUS_LABELS[status],
    value: stats.tasks_by_status[status],
    hue: TASK_HUES[status],
  }))
}

function total(record: Record<string, number>): number {
  return Object.values(record).reduce((sum, value) => sum + value, 0)
}

export interface ActivityFigures {
  // All journal entries of the mission (`sum(logs_by_event_type)`), not limited to the period.
  logs: number
  sessions: number
  // logs / agents seen in `agents[]`; null without any agent (never 0).
  logsPerAgent: number | null
  // logs / sessions; null without any session.
  logsPerSession: number | null
  // Journal entries of the busiest period bucket of the selected window (UTC); null when the window is silent.
  peak: { bucket: string; count: number } | null
}

export function activityFigures(stats: MissionStatistics): ActivityFigures {
  const logs = total(stats.logs_by_event_type)
  const sessions = total(stats.sessions_by_status)
  let peak: ActivityFigures['peak'] = null
  for (const point of stats.logs_series) {
    if (point.count > 0 && (peak === null || point.count > peak.count)) peak = point
  }
  return {
    logs,
    sessions,
    logsPerAgent: stats.agents.length > 0 ? logs / stats.agents.length : null,
    logsPerSession: sessions > 0 ? logs / sessions : null,
    peak: peak && { bucket: peak.bucket, count: peak.count },
  }
}

// Mission-level attention counters: what went wrong or is waiting (errors/warnings in the journal, failed tasks,
// timed-out sessions). All exact counts of existing rows, so a zero is a proven zero.
export interface AttentionFigures {
  errors: number
  warnings: number
  failedTasks: number
  timedOutSessions: number
}

export function attentionFigures(stats: MissionStatistics): AttentionFigures {
  return {
    errors: stats.logs_by_event_type.error,
    warnings: stats.logs_by_event_type.warning,
    failedTasks: stats.tasks_by_status.failed,
    timedOutSessions: stats.sessions_by_status.timed_out,
  }
}
