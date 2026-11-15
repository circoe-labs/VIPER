import type { HomeDashboard, HomeData } from '../api/home'
import type { MissionList } from '../api/missions'
import type { WeeklyMetrics } from '../api/metrics'
import { REVIEWS, SEGMENTS, type Counters } from '../api/prospection'
import type { ApiReply } from './render'

// Synthetic answers of GET /api/home (backend/app/api/routes/home.py) for component tests. The aggregates themselves
// are computed and tested in the backend; the default is an empty base.

export function homeData(overrides: Partial<HomeData> = {}): HomeData {
  return {
    today: '2026-09-10',
    stale_threshold_days: null,
    counts: Object.fromEntries(SEGMENTS.map((segment) => [segment, 0])) as HomeData['counts'],
    figures: {
      disqualified: 0,
      mail_inactive: 0,
      incomplete: 0,
      responses_this_week: 0,
      responses_last_week: 0,
      responses_this_month: 0,
    },
    companies: 0,
    progress: {
      contact_target: 100,
      appointment_target: 10,
      months: ['04', '05', '06', '07', '08', '09'].map((month) => ({
        month: `2026-${month}-01`,
        contacted: 0,
        appointments: 0,
      })),
    },
    contact_week: { week: '2026-W37', monday: '2026-09-07', to_send: 0, overdue: 0 },
    next_actions: {
      appointments: { total: 0, items: [] },
      due: { total: 0, items: [] },
      responses: { total: 0, items: [] },
    },
    recent_imports: [],
    recent_edits: [],
    ...overrides,
  }
}

export function homeDashboard(overrides: Partial<HomeDashboard> = {}): HomeDashboard {
  return {
    prospects: 0, warehouse_contacts: 0, companies: 0, contacted: 0, appointments: 0,
    weekly_activity: { prospects: 0, companies: 0, warehouses: 0, contacts: 0, appointments: 0 },
    prospect_trend: [], new_companies: 0, new_prospects: 0, week_start: '2026-10-26', week_end: '2026-11-01',
    ...overrides,
  }
}

export function weeklyMetrics(overrides: Partial<WeeklyMetrics> = {}): WeeklyMetrics {
  return {
    timezone: 'Europe/Paris', week: '2026-W44', week_start: '2026-10-26', week_end: '2026-11-01', today: '2026-10-30',
    additions: { prospects: 0, companies: 0, warehouses: 0 },
    contact_stock: {
      to_contact: 0, to_send: 0, overdue: 0, first_contact_to_send: 0, follow_up_to_send: 0, follow_up_overdue: 0,
      upcoming: 0, contacted: 0, responses: 0, appointments: 0, mail_error: 0,
    },
    contact_events: { first_contacts: 0, first_appointments: 0, responses: 0, mail_errors_opened: 0, status_entries: {} },
    prospection_sub_status_deltas: null,
    ...overrides,
  }
}

export function prospectionCounters(toVerify = 0): Counters {
  return {
    counts: Object.fromEntries(SEGMENTS.map((segment) => [segment, 0])) as Counters['counts'],
    reviews: Object.fromEntries(REVIEWS.map((review) => [review, { total: review === 'to_verify' ? toVerify : 0, week: 0 }])) as Counters['reviews'],
    today: '2026-09-10',
    stale_threshold_days: null,
  }
}

export const NO_MISSIONS: MissionList = { items: [], total: 0 }

// What any page of the signed-in shell may ask on load when it lands on Accueil: the health probe and Home.
export const SHELL_API: Record<string, ApiReply> = {
  'GET /api/health': [200, { status: 'ok', database: 'ok' }],
  'GET /api/home': [200, homeData()],
  'GET /api/home/dashboard': [200, homeDashboard()],
  'GET /api/metrics/weekly': [200, weeklyMetrics()],
  'GET /api/metrics/weekly-series': [200, { timezone: 'Europe/Paris', today: '2026-11-14', weeks: [], totals: { contacted: 0, with_appointment: 0, base_appointment: 0, base_ignored: 0, base_contacted: 0, base_not_contacted: 0 } }],
  'GET /api/prospection/counters': [200, prospectionCounters()],
  'GET /api/prospection/overview': [200, { total: 1051, contacted: 0, deleted: 0, ignored: 0, employment_validated: 0, employment_pending: 0, uncertain: 0, todo: 0 }],
  'GET /api/companies/counts': [200, { all: 812, institutional: 0, sme: 0, large: 0, unclassified: 812 }],
  'GET /api/warehouses/counts': [200, { warehouses: 36, contacts: 0, to_contact: 0, sme: 0, other: 0, unclassified: 36 }],
  'GET /api/missions': [200, NO_MISSIONS],
}
