// Local adapter between Prospection and the weekly-additions figures ("+N cette semaine").
//
// Today the only honest source is `/home/dashboard` `weekly_activity` (api/home.ts, owned by Slice 01 / Home). Prospection
// never reads that payload directly: when Slice 01 exposes its metrics read model, only this file changes.
// A figure the source does not provide is `null` = unavailable (the UI hides it or says so), never 0.
//
// Per-sub-status weekly deltas (validé, incertain, à vérifier…) have NO backend basis yet: `byStatus` stays empty
// until Slice 01 ships one; capsules show a delta only when a key is present here.
import { type HomeDashboard, useHomeDashboard } from '../api/home'
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

export function weeklyAdditionsFrom(data: Pick<HomeDashboard, 'weekly_activity'> | undefined): WeeklyAdditions {
  const activity: Partial<HomeDashboard['weekly_activity']> | undefined = data?.weekly_activity
  if (!activity) return { added: UNKNOWN, byStatus: {}, state: 'unavailable' }
  return {
    added: { prospect: count(activity.prospects), company: count(activity.companies), warehouse: count(activity.warehouses) },
    byStatus: {},
    state: 'ready',
  }
}

export function useWeeklyAdditions(): WeeklyAdditions {
  const query = useHomeDashboard()
  if (query.isPending) return { added: UNKNOWN, byStatus: {}, state: 'loading' }
  return query.isError ? { added: UNKNOWN, byStatus: {}, state: 'unavailable' } : weeklyAdditionsFrom(query.data)
}
