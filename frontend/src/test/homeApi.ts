import type { HomeData } from '../api/home'
import { SEGMENTS } from '../api/prospection'
import type { ApiReply } from './render'

// Synthetic answers of GET /api/home (backend/app/api/routes/home.py) for component tests. The aggregates themselves
// are computed and tested in the backend; the default is an empty base.

export function homeData(overrides: Partial<HomeData> = {}): HomeData {
  return {
    today: '2026-09-10',
    stale_threshold_days: null,
    counts: Object.fromEntries(SEGMENTS.map((segment) => [segment, 0])) as HomeData['counts'],
    companies: 0,
    stages: { quote_sent: 0, quote_follow_up: 0, won: 0, not_interested: 0 },
    progress: {
      contact_target: 100,
      appointment_target: 10,
      months: ['04', '05', '06', '07', '08', '09'].map((month) => ({
        month: `2026-${month}-01`,
        contacted: 0,
        appointments: 0,
      })),
    },
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

// What any page of the signed-in shell may ask on load when it lands on Accueil: the health probe and Home.
export const SHELL_API: Record<string, ApiReply> = {
  'GET /api/health': [200, { status: 'ok', database: 'ok' }],
  'GET /api/home': [200, homeData()],
}
