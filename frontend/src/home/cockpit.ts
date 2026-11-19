import type { WeeklyMetrics } from '../api/metrics'
import type { MissionList } from '../api/missions'
import { BuildingIcon, CalendarIcon, CheckCircleIcon, SparklesIcon, UserPlusIcon, WarehouseIcon, type IconComponent } from '../ui/icons'
import { HOME_DESTINATIONS, type HomeCardId } from './destinations'

// Adapter: turns the weekly read model (GET /api/metrics/weekly, doc/features/weekly-metrics.md) and the Missions list into
// the SIX counters of the Home (the rest of the contact pipeline is drawn by charts, see pipeline.ts). A card whose source is missing (loading, failed, absent) is
// simply not produced: never a zero, never an estimate. Every Contact card counts what its destination list shows
// (`first_contact_to_send` = view `to_contact`, `follow_up_to_send` = `follow_ups`, `appointments` = `appointments`).

export interface CockpitCard {
  id: HomeCardId
  label: string
  // The overall figure (undefined while it loads). Never replaced by the weekly figure.
  count: number | undefined
  // « +N cette semaine » next to the overall figure, only when the source states it (null = unavailable).
  weekly?: number | null
  icon: IconComponent
  tone: 'blue' | 'purple' | 'green' | 'orange' | 'emerald'
  href: string
}

export interface CockpitSources {
  metrics: WeeklyMetrics | undefined
  missions: MissionList | undefined
  // Overall sizes of the base (same sources as the Prospection cards).
  totals?: { prospects?: number; companies?: number; warehouses?: number }
}

export function buildCockpit({ metrics, missions, totals }: CockpitSources): CockpitCard[] {
  const context = { weekStart: metrics?.week_start }
  const card = (id: HomeCardId, rest: Omit<CockpitCard, 'id' | 'href'>): CockpitCard => ({ id, href: HOME_DESTINATIONS[id](context), ...rest })
  const week = metrics?.additions
  const items = missions?.items

  // Fixed order = fixed grid: the base (3), appointments, missions (2). A card whose source is missing is left out.
  return [
    ...(week ? [
      card('new_prospects', { label: 'Prospects', count: totals?.prospects, weekly: week.prospects, icon: UserPlusIcon, tone: 'blue' }),
      card('new_companies', { label: 'Entreprises', count: totals?.companies, weekly: week.companies, icon: BuildingIcon, tone: 'purple' }),
      card('new_warehouses', { label: 'Entrepôts', count: totals?.warehouses, weekly: week.warehouses, icon: WarehouseIcon, tone: 'emerald' }),
    ] : []),
    metrics && card('appointments', { label: 'Rendez-vous pris', count: metrics.contact_stock.appointments, weekly: metrics.contact_events.first_appointments, icon: CalendarIcon, tone: 'orange' }),
    ...(items ? [
      card('missions_active', { label: 'Missions en cours', count: items.filter((mission) => mission.status === 'active').length, icon: SparklesIcon, tone: 'purple' }),
      card('reviews_pending', { label: 'Résultats à vérifier', count: items.reduce((sum, mission) => sum + mission.results_pending, 0), icon: CheckCircleIcon, tone: 'orange' }),
    ] : []),
  ].filter((entry): entry is CockpitCard => !!entry)
}
