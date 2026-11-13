import { describe, expect, it } from 'vitest'

import { card } from './missionTestData'
import {
  agentLabel,
  DEFAULT_FILTERS,
  filterMissions,
  isFiltered,
  missionCounters,
  plural,
  progressPercent,
  reviewQueueTotal,
  sortMissions,
} from './missionsListModel'

const A = card({
  id: 'a',
  name: 'Éole',
  status: 'active',
  type: 'prospection',
  last_run_at: '2026-11-01T10:00:00+00:00',
  created_at: '2026-10-01T00:00:00+00:00',
})
const B = card({
  id: 'b',
  name: 'alpha',
  status: 'paused',
  type: 'signals',
  last_run_at: '2026-11-05T10:00:00+00:00',
  created_at: '2026-10-03T00:00:00+00:00',
})
const C = card({
  id: 'c',
  name: 'Zèbre',
  status: 'done',
  type: 'prospection',
  last_run_at: null,
  created_at: '2026-10-09T00:00:00+00:00',
})
const D = card({
  id: 'd',
  name: 'Delta',
  status: 'active',
  type: 'other',
  last_run_at: null,
  created_at: '2026-10-05T00:00:00+00:00',
})
const ALL = [A, B, C, D]

describe('filterMissions', () => {
  it('keeps everything by default', () => {
    expect(filterMissions(ALL, DEFAULT_FILTERS)).toHaveLength(4)
  })

  it('combines the status and the type', () => {
    expect(filterMissions(ALL, { status: 'active', type: 'all' }).map((m) => m.id)).toEqual(['a', 'd'])
    expect(filterMissions(ALL, { status: 'active', type: 'prospection' }).map((m) => m.id)).toEqual(['a'])
    expect(filterMissions(ALL, { status: 'cancelled', type: 'all' })).toEqual([])
  })

  it('says whether a filter is applied (the sort is not a filter)', () => {
    expect(isFiltered(DEFAULT_FILTERS)).toBe(false)
    expect(isFiltered({ ...DEFAULT_FILTERS, sort: 'name' })).toBe(false)
    expect(isFiltered({ ...DEFAULT_FILTERS, type: 'other' })).toBe(true)
  })
})

describe('sortMissions', () => {
  it('sorts by last run, newest first, never-run missions last then by creation', () => {
    expect(sortMissions(ALL, 'last_run').map((m) => m.id)).toEqual(['b', 'a', 'c', 'd'])
  })

  it('sorts by creation, newest first', () => {
    expect(sortMissions(ALL, 'created').map((m) => m.id)).toEqual(['c', 'd', 'b', 'a'])
  })

  it('sorts by name, ignoring case and accents', () => {
    expect(sortMissions(ALL, 'name').map((m) => m.name)).toEqual(['alpha', 'Delta', 'Éole', 'Zèbre'])
  })

  it('does not mutate its input', () => {
    const input = [...ALL]
    sortMissions(input, 'name')
    expect(input).toEqual(ALL)
  })
})

describe('missionCounters', () => {
  it('counts from the items given (the caller passes the unfiltered list)', () => {
    expect(missionCounters(ALL)).toEqual({ total: 4, active: 2, done: 1 })
    expect(missionCounters([])).toEqual({ total: 0, active: 0, done: 0 })
  })
})

describe('reviewQueueTotal', () => {
  it('adds the results pending on the cards to the proposals outside any mission', () => {
    expect(reviewQueueTotal([card({ id: 'x', results_pending: 3 }), card({ id: 'y', results_pending: 0 })], 2)).toBe(5)
    expect(reviewQueueTotal([], 0)).toBe(0)
  })
})

describe('progressPercent', () => {
  it('is tasks_done / tasks_total, rounded', () => {
    expect(progressPercent({ tasks_done: 7, tasks_total: 8 })).toBe(88)
    expect(progressPercent({ tasks_done: 0, tasks_total: 5 })).toBe(0)
    expect(progressPercent({ tasks_done: 5, tasks_total: 5 })).toBe(100)
  })

  it('is null, not 0 %, when the mission has no task', () => {
    expect(progressPercent({ tasks_done: 0, tasks_total: 0 })).toBeNull()
  })

  it('stays within 0-100', () => {
    expect(progressPercent({ tasks_done: 9, tasks_total: 3 })).toBe(100)
  })
})

describe('labels', () => {
  it('falls back to « Automatique » without a configured agent', () => {
    expect(agentLabel({ agent_label: null })).toBe('Automatique')
    expect(agentLabel({ agent_label: 'Agent claude-01' })).toBe('Agent claude-01')
  })

  it('pluralises', () => {
    expect(plural(0, 'tâche')).toBe('0 tâche')
    expect(plural(1, 'tâche')).toBe('1 tâche')
    expect(plural(8, 'tâche')).toBe('8 tâches')
  })
})
