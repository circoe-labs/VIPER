import type { MissionCard, MissionStatus, MissionType } from '../api/missions'

// View model of the Missions list (Slice 02 of viper_mission_ui_redesign). Pure: filter, sort and counters are all
// derived client-side from the ONE unfiltered `useMissions()` query, so the header counters never move when a filter
// is applied. Nothing here invents a figure: progress is tasks_done / tasks_total, and no total means no progress.

export type StatusFilter = 'all' | MissionStatus
export type TypeFilter = 'all' | MissionType
export type SortKey = 'last_run' | 'created' | 'name'

export interface ListFilters {
  status: StatusFilter
  type: TypeFilter
  sort: SortKey
}

export const DEFAULT_FILTERS: ListFilters = { status: 'all', type: 'all', sort: 'last_run' }

export const STATUS_FILTER_OPTIONS: { value: StatusFilter; label: string }[] = [
  { value: 'all', label: 'Toutes les missions' },
  { value: 'active', label: 'Actives' },
  { value: 'paused', label: 'Inactives' },
  { value: 'done', label: 'Terminées' },
  { value: 'cancelled', label: 'Annulées' },
]

export const SORT_OPTIONS: { value: SortKey; label: string }[] = [
  { value: 'last_run', label: 'Dernière exécution' },
  { value: 'created', label: 'Date de création' },
  { value: 'name', label: 'Nom' },
]

export function isFiltered(filters: ListFilters): boolean {
  return filters.status !== 'all' || filters.type !== 'all'
}

export function filterMissions(items: MissionCard[], filters: Pick<ListFilters, 'status' | 'type'>): MissionCard[] {
  return items.filter(
    (card) =>
      (filters.status === 'all' || card.status === filters.status) &&
      (filters.type === 'all' || card.type === filters.type),
  )
}

// Most recent first; a mission that never ran sorts after every one that did.
function byDateDesc(left: string | null, right: string | null): number {
  if (left === right) return 0
  if (left === null) return 1
  if (right === null) return -1
  return new Date(right).getTime() - new Date(left).getTime()
}

function sortedBy(items: MissionCard[], sort: SortKey): MissionCard[] {
  const copy = [...items]
  if (sort === 'name') return copy.sort((a, b) => a.name.localeCompare(b.name, 'fr', { sensitivity: 'base' }))
  if (sort === 'created') return copy.sort((a, b) => byDateDesc(a.created_at, b.created_at))
  return copy.sort((a, b) => byDateDesc(a.last_run_at, b.last_run_at) || byDateDesc(a.created_at, b.created_at))
}

// The permanent « Dépôt » mission is pinned first, whatever the sort.
export function sortMissions(items: MissionCard[], sort: SortKey): MissionCard[] {
  const sorted = sortedBy(items, sort)
  return [...sorted.filter((card) => card.is_deposit), ...sorted.filter((card) => !card.is_deposit)]
}

export interface MissionCounters {
  total: number
  active: number
  // « Terminées »: all time. The card carries no completion date, so « 30 jours » cannot be computed (decision D1).
  done: number
}

export function missionCounters(items: MissionCard[]): MissionCounters {
  return {
    total: items.length,
    active: items.filter((card) => card.status === 'active').length,
    done: items.filter((card) => card.status === 'done').length,
  }
}

// « En attente de relecture »: every result a person still has to decide. A mission's own results are on its cards
// (`results_pending`); tool-mode proposals outside any mission run come from `GET /missions/proposals` and are added.
export function reviewQueueTotal(items: MissionCard[], standaloneProposals: number): number {
  return items.reduce((sum, card) => sum + card.results_pending, standaloneProposals)
}

// Share of the mission's tasks that were accepted (« X % validées »), 0-100. `null` when the mission has no task:
// never 0 % for « nothing to do yet ».
export function progressPercent(card: Pick<MissionCard, 'tasks_done' | 'tasks_total'>): number | null {
  if (card.tasks_total <= 0) return null
  return Math.min(100, Math.max(0, Math.round((card.tasks_done / card.tasks_total) * 100)))
}

// Slot « agents » of the card: the one configured agent, else the automatic assignment (decision D2).
export function agentLabel(card: Pick<MissionCard, 'agent_label'>): string {
  return card.agent_label ?? 'Automatique'
}

export function plural(count: number, one: string, many: string = `${one}s`): string {
  return `${String(count)} ${count > 1 ? many : one}`
}
