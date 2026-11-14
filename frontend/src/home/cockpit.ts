import type { WeeklyMetrics } from '../api/metrics'
import type { MissionList } from '../api/missions'
import type { Counters } from '../api/prospection'
import { BuildingIcon, CalendarIcon, CheckCircleIcon, ClockIcon, MailIcon, SparklesIcon, UserPlusIcon, WarehouseIcon, type IconComponent } from '../ui/icons'
import { HOME_DESTINATIONS, type HomeCardId } from './destinations'

// Adapter: turns the weekly read model (GET /api/metrics/weekly, doc/features/weekly-metrics.md), the Prospection
// counters and the Missions list into the small cockpit. A card whose source is missing (loading, failed, absent) is
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
  // Honest secondary line, only when the source states it (e.g. the overdue part of the due follow-ups).
  hint?: string
}

export interface CockpitSection {
  title: string
  cards: CockpitCard[]
}

export interface CockpitSources {
  metrics: WeeklyMetrics | undefined
  counters: Counters | undefined
  missions: MissionList | undefined
  // Overall sizes of the base (same sources as the Prospection cards).
  totals?: { prospects?: number; companies?: number; warehouses?: number }
}

export function buildCockpit({ metrics, counters, missions, totals }: CockpitSources): CockpitSection[] {
  const context = { weekStart: metrics?.week_start }
  const card = (id: HomeCardId, rest: Omit<CockpitCard, 'id' | 'href'>): CockpitCard => ({ id, href: HOME_DESTINATIONS[id](context), ...rest })
  const week = metrics?.additions
  const stock = metrics?.contact_stock
  const items = missions?.items

  const contact: (CockpitCard | undefined)[] = [
    stock && card('appointments', { label: 'Rendez-vous pris', count: stock.appointments, weekly: metrics.contact_events.first_appointments, icon: CalendarIcon, tone: 'orange' }),
    stock && card('to_contact', { label: 'À contacter', count: stock.first_contact_to_send, icon: MailIcon, tone: 'green' }),
    stock && card('due', {
      label: 'Relances dues', count: stock.follow_up_to_send, icon: ClockIcon, tone: 'orange',
      hint: stock.follow_up_overdue > 0 ? `dont ${String(stock.follow_up_overdue)} en retard` : undefined,
    }),
    counters && card('to_verify', { label: 'À vérifier', count: counters.reviews.to_verify.total, weekly: counters.reviews.to_verify.week, icon: CheckCircleIcon, tone: 'blue' }),
  ]

  const sections: CockpitSection[] = [
    {
      title: 'La base',
      cards: week ? [
        card('new_prospects', { label: 'Prospects', count: totals?.prospects, weekly: week.prospects, icon: UserPlusIcon, tone: 'blue' }),
        card('new_companies', { label: 'Entreprises', count: totals?.companies, weekly: week.companies, icon: BuildingIcon, tone: 'purple' }),
        card('new_warehouses', { label: 'Entrepôts', count: totals?.warehouses, weekly: week.warehouses, icon: WarehouseIcon, tone: 'emerald' }),
      ] : [],
    },
    { title: 'À traiter', cards: contact.filter((entry): entry is CockpitCard => entry !== undefined) },
    {
      title: 'Missions',
      cards: items ? [
        card('missions_active', { label: 'Missions en cours', count: items.filter((mission) => mission.status === 'active').length, icon: SparklesIcon, tone: 'purple' }),
        card('missions_done', { label: 'Missions terminées', count: items.filter((mission) => mission.status === 'done').length, icon: CheckCircleIcon, tone: 'green' }),
        card('reviews_pending', { label: 'Reviews en attente', count: items.reduce((sum, mission) => sum + mission.results_pending, 0), icon: CheckCircleIcon, tone: 'orange' }),
      ] : [],
    },
  ]
  return sections.filter((section) => section.cards.length > 0)
}
