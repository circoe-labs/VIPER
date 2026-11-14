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
  count: number
  icon: IconComponent
  tone: 'blue' | 'purple' | 'green' | 'orange' | 'emerald'
  href: string
  growth?: boolean
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
}

export function buildCockpit({ metrics, counters, missions }: CockpitSources): CockpitSection[] {
  const context = { weekStart: metrics?.week_start }
  const card = (id: HomeCardId, rest: Omit<CockpitCard, 'id' | 'href'>): CockpitCard => ({ id, href: HOME_DESTINATIONS[id](context), ...rest })
  const week = metrics?.additions
  const stock = metrics?.contact_stock
  const items = missions?.items

  const contact: (CockpitCard | undefined)[] = [
    stock && card('appointments', { label: 'Rendez-vous pris', count: stock.appointments, icon: CalendarIcon, tone: 'orange' }),
    stock && card('to_contact', { label: 'À contacter', count: stock.first_contact_to_send, icon: MailIcon, tone: 'green' }),
    stock && card('due', {
      label: 'Relances dues', count: stock.follow_up_to_send, icon: ClockIcon, tone: 'orange',
      hint: stock.follow_up_overdue > 0 ? `dont ${String(stock.follow_up_overdue)} en retard` : undefined,
    }),
    counters && card('to_verify', { label: 'À vérifier', count: counters.reviews.to_verify.total, icon: CheckCircleIcon, tone: 'blue' }),
  ]

  const sections: CockpitSection[] = [
    {
      title: 'Cette semaine',
      cards: week ? [
        card('new_prospects', { label: 'Nouveaux prospects', count: week.prospects, icon: UserPlusIcon, tone: 'blue', growth: true }),
        card('new_companies', { label: 'Nouvelles entreprises', count: week.companies, icon: BuildingIcon, tone: 'purple', growth: true }),
        card('new_warehouses', { label: 'Nouveaux entrepôts', count: week.warehouses, icon: WarehouseIcon, tone: 'emerald', growth: true }),
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
