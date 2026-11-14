import type { HomeData, HomeDashboard } from '../api/home'
import type { MissionList } from '../api/missions'
import type { Counters } from '../api/prospection'
import { BuildingIcon, CalendarIcon, CheckCircleIcon, ClockIcon, MailIcon, SparklesIcon, UserPlusIcon, WarehouseIcon, type IconComponent } from '../ui/icons'
import { HOME_DESTINATIONS, type HomeCardId } from './destinations'

// Adapter: turns what existing reads already answer (Home dashboard, Home planning, Prospection counters, Missions
// list) into the small cockpit. A card whose source is missing (loading, failed, absent) is simply not produced: never
// a zero, never an estimate. No new backend contract; Slice 01 may later swap sources behind this function.

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
  dashboard: HomeDashboard | undefined
  home: HomeData | undefined
  counters: Counters | undefined
  missions: MissionList | undefined
}

export function buildCockpit({ dashboard, home, counters, missions }: CockpitSources): CockpitSection[] {
  const context = { weekStart: dashboard?.week_start }
  const card = (id: HomeCardId, rest: Omit<CockpitCard, 'id' | 'href'>): CockpitCard => ({ id, href: HOME_DESTINATIONS[id](context), ...rest })
  const week = dashboard?.weekly_activity
  const items = missions?.items

  const contact: (CockpitCard | undefined)[] = [
    dashboard && card('appointments', { label: 'Rendez-vous pris', count: dashboard.appointments, icon: CalendarIcon, tone: 'orange' }),
    home && card('to_contact', { label: 'À contacter', count: home.counts.to_contact, icon: MailIcon, tone: 'green' }),
    home && card('due', {
      label: 'Relances dues', count: home.counts.due, icon: ClockIcon, tone: 'orange',
      hint: home.contact_week.overdue > 0 ? `dont ${String(home.contact_week.overdue)} en retard` : undefined,
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
