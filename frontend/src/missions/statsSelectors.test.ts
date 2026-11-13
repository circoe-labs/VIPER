import { describe, expect, it } from 'vitest'

import type { MissionOverview, MissionStatistics } from '../api/missions'
import { donutModel } from './donutModel'
import {
  activityFigures,
  agentActivityDonut,
  attentionFigures,
  progressOf,
  resultsDonut,
  tasksDonut,
} from './statsSelectors'

function overview(total: number, finished: number): MissionOverview {
  return { tasks: { total, finished, by_status: {} }, active_agents: 2 } as unknown as MissionOverview
}

const STATS = {
  results_by_status: { pending_review: 1, accepted: 3, rejected: 1, superseded: 0 },
  tasks_by_status: { pending: 0, claimed: 1, submitted: 1, accepted: 3, failed: 2, cancelled: 0 },
  sessions_by_status: { active: 1, ended: 2, timed_out: 1 },
  logs_by_event_type: {
    search: 4,
    source_opened: 6,
    observation: 0,
    verification: 2,
    progress: 1,
    warning: 1,
    error: 3,
    decision_summary: 0,
  },
  logs_series: [
    { bucket: '2026-11-10T00:00:00Z', count: 0 },
    { bucket: '2026-11-11T00:00:00Z', count: 9 },
    { bucket: '2026-11-12T00:00:00Z', count: 8 },
  ],
  agents: [
    { agent_id: 'a1', agent_label: 'Agent 01', sessions: 3, logs: 5, results: 4, accepted: 3, rejected: 1, pending_review: 0 },
    { agent_id: 'a2', agent_label: 'Agent 02', sessions: 1, logs: 12, results: 1, accepted: 0, rejected: 0, pending_review: 1 },
    { agent_id: 'a3', agent_label: 'Agent 03', sessions: 1, logs: 0, results: 0, accepted: 0, rejected: 0, pending_review: 0 },
  ],
} as unknown as MissionStatistics

describe('progressOf', () => {
  it('is exact and rounded', () => {
    expect(progressOf(overview(100, 87))).toEqual({ total: 100, finished: 87, remaining: 13, percent: 87 })
    expect(progressOf(overview(3, 1)).percent).toBe(33)
  })

  it('never reports 0 % without any task', () => {
    expect(progressOf(overview(0, 0))).toEqual({ total: 0, finished: 0, remaining: 0, percent: null })
  })

  it('clamps an impossible finished count', () => {
    const progress = progressOf(overview(4, 9))
    expect(progress.percent).toBe(100)
    expect(progress.remaining).toBe(0)
  })
})

describe('agentActivityDonut', () => {
  it('ranks by entries, drops silent agents and colours by rank', () => {
    const segments = agentActivityDonut(STATS)
    expect(segments.map((s) => [s.key, s.value, s.hue])).toEqual([
      ['a2', 12, 'green'],
      ['a1', 5, 'blue'],
    ])
  })

  it('does not mutate the payload order', () => {
    agentActivityDonut(STATS)
    expect(STATS.agents.map((a) => a.agent_id)).toEqual(['a1', 'a2', 'a3'])
  })

  it('is an empty ring input without agents', () => {
    expect(donutModel(agentActivityDonut({ ...STATS, agents: [] })).total).toBe(0)
  })
})

describe('status donuts', () => {
  it('maps results to status hues with plural labels', () => {
    const rows = resultsDonut(STATS)
    expect(rows.map((r) => [r.label, r.value, r.hue])).toEqual([
      ['Acceptés', 3, 'success'],
      ['Refusés', 1, 'danger'],
      ['À relire', 1, 'amber'],
      ['Remplacés', 0, 'neutral'],
    ])
    expect(donutModel(rows).total).toBe(5)
  })

  it('covers every task status once and keeps the totals', () => {
    const rows = tasksDonut(STATS)
    expect(rows).toHaveLength(6)
    expect(donutModel(rows).total).toBe(7)
    expect(rows.find((r) => r.key === 'failed')?.hue).toBe('danger')
  })
})

describe('activityFigures', () => {
  it('derives averages and the busiest UTC bucket from exact counters', () => {
    const figures = activityFigures(STATS)
    expect(figures.logs).toBe(17)
    expect(figures.sessions).toBe(4)
    expect(figures.logsPerSession).toBe(17 / 4)
    expect(figures.logsPerAgent).toBe(17 / 3)
    expect(figures.peak).toEqual({ bucket: '2026-11-11T00:00:00Z', count: 9 })
  })

  it('returns null, not 0, when the denominator or the window is empty', () => {
    const figures = activityFigures({
      ...STATS,
      agents: [],
      sessions_by_status: { active: 0, ended: 0, timed_out: 0 },
      logs_series: [{ bucket: '2026-11-10T00:00:00Z', count: 0 }],
    })
    expect(figures.logsPerAgent).toBeNull()
    expect(figures.logsPerSession).toBeNull()
    expect(figures.peak).toBeNull()
  })

  it('keeps the first bucket on a tie', () => {
    const figures = activityFigures({
      ...STATS,
      logs_series: [
        { bucket: 'a', count: 5 },
        { bucket: 'b', count: 5 },
      ],
    })
    expect(figures.peak?.bucket).toBe('a')
  })
})

describe('attentionFigures', () => {
  it('reads errors, warnings, failed tasks and timed-out sessions', () => {
    expect(attentionFigures(STATS)).toEqual({ errors: 3, warnings: 1, failedTasks: 2, timedOutSessions: 1 })
  })
})
