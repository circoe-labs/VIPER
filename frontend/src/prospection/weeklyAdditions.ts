// Local adapter between Prospection and the weekly-additions figures ("+N cette semaine").
//
// Source: `GET /api/metrics/weekly` `additions` (api/metrics.ts, doc/features/weekly-metrics.md): rows whose `created_at`
// is in the business week (Monday to Monday, Europe/Paris). Prospection never reads that payload directly.
// A figure the source does not provide is `null` = unavailable (the UI hides it or says so), never 0.
//
// Per-sub-status weekly deltas (validé, incertain, à vérifier…) are NOT computable (`prospection_sub_status_deltas` is
// always null): `byStatus` stays empty and must never be filled by differencing two stock counts.
import { type WeeklyMetrics, useWeeklyMetrics } from '../api/metrics'
import type { Entity } from './criteria'

export type StatusKey = 'employment_validated' | 'uncertain' | 'todo' | 'ignored'

export interface WeeklyAdditions {
  // Added in the current week, per entity; null when unknown.
  added: Record<Entity, number | null>
  byStatus: Partial<Record<StatusKey, number>>
  // 'loading' → show nothing yet; 'unavailable' → the source failed or lacks the figure, say so.
  state: 'loading' | 'ready' | 'unavailable'
}

const UNKNOWN: WeeklyAdditions['added'] = { prospect: null, company: null, warehouse: null }

function count(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

export function weeklyAdditionsFrom(data: Pick<WeeklyMetrics, 'additions'> | undefined): WeeklyAdditions {
  const additions: Partial<WeeklyMetrics['additions']> | undefined = data?.additions
  if (!additions) return { added: UNKNOWN, byStatus: {}, state: 'unavailable' }
  return {
    added: { prospect: count(additions.prospects), company: count(additions.companies), warehouse: count(additions.warehouses) },
    byStatus: {},
    state: 'ready',
  }
}

export function useWeeklyAdditions(): WeeklyAdditions {
  const query = useWeeklyMetrics()
  if (query.isPending) return { added: UNKNOWN, byStatus: {}, state: 'loading' }
  return query.isError ? { added: UNKNOWN, byStatus: {}, state: 'unavailable' } : weeklyAdditionsFrom(query.data)
}
