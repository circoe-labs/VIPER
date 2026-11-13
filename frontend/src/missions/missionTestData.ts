import type { MissionCategory } from '../api/missionConfig'
import type { MissionCard, MissionDetail, MissionOptions, MissionType } from '../api/missions'
import type { ApiReply } from '../test/render'

export const MISSION = '00000000-0000-7000-e000-000000000010'
export const COMPANY = '00000000-0000-7000-f000-000000000001'

export const OPTIONS: MissionOptions = {
  types: [
    { value: 'prospection', executable: true },
    { value: 'signals', executable: true },
    { value: 'enrichment', executable: true },
    { value: 'verification', executable: true },
    { value: 'other', executable: true },
  ],
  result_kinds: [
    { value: 'companies', executable: true },
    { value: 'prospects', executable: true },
    { value: 'signals', executable: true },
    { value: 'enrichment', executable: true },
  ],
  units: ['hours', 'days', 'weeks', 'months'],
  end_kinds: ['never', 'date', 'after'],
  result_limit_max: 500,
}

export function card(overrides: Partial<MissionCard> = {}): MissionCard {
  return {
    id: MISSION,
    name: 'Nouveaux entrepôts — Normandie',
    type: 'enrichment',
    status: 'active',
    agent_label: 'Agent claude-01',
    prompt: 'Complète ces fiches avec le site web et le domaine e-mail.',
    is_recurring: true,
    interval_count: 24,
    interval_unit: 'hours',
    targets_count: 1,
    runs_count: 1,
    last_run_at: '2026-10-30T08:00:00+00:00',
    last_run_status: 'running',
    last_run_results: 1,
    next_run_at: '2026-10-31T08:00:00+00:00',
    tasks_total: 1,
    tasks_done: 0,
    results_pending: 1,
    created_at: '2026-10-30T07:00:00+00:00',
    ...overrides,
  }
}

export function detail(): MissionDetail {
  return {
    card: card(),
    targets: [{ kind: 'company', id: COMPANY, label: 'Transports X', hint: 'Rouen' }],
    sources: [{ id: 'source-1', url: 'https://www.example.com/annuaire', label: 'Annuaire', missions_count: 2 }],
    runs: [
      {
        id: '00000000-0000-7000-e000-000000000020',
        status: 'running',
        trigger: 'manual',
        scheduled_at: '2026-10-30T08:00:00+00:00',
        started_at: '2026-10-30T08:00:00+00:00',
        finished_at: null,
        tasks_total: 1,
        results_count: 1,
        note: null,
      },
    ],
    tasks: [
      {
        id: '00000000-0000-7000-e000-000000000030',
        type: 'update_company',
        status: 'submitted',
        company_id: COMPANY,
        prospect_id: null,
        prospect_name: null,
        claimed_by_label: 'Agent claude-01',
        assigned_agent_id: null,
        result_id: '00000000-0000-7000-e000-000000000040',
        submitted_at: '2026-10-30T08:05:00+00:00',
      },
    ],
    prompt: 'Complète ces fiches avec le site web et le domaine e-mail.',
    result_kind: 'enrichment',
    result_limit: 20,
    rule: {
      agent_id: null,
      starts_at: '2026-10-30T07:00:00+00:00',
      end_kind: 'never',
      ends_at: null,
      max_runs: null,
      geography: 'Normandie',
      period_days: null,
      exclusions: {},
    },
  }
}

function category(key: MissionType, name: string, icon: string, color: string, description: string): MissionCategory {
  return {
    id: `cat-${key}`,
    key,
    is_system: true,
    name,
    description,
    icon,
    color,
    general_prompt: `Consigne générale : ${name}.`,
    mission_type: key,
    position: 0,
    skills: key === 'enrichment' ? [{ id: 'skill-1', name: 'Sources fiables' }] : [],
    sources: [],
    missions_count: 0,
  }
}

// The five seeded categories (doc/architecture/missions.md §7c).
export const CATEGORIES: MissionCategory[] = [
  category('prospection', 'Prospection', 'compass', '#2563eb', 'Trouver de nouvelles sociétés ou de nouveaux contacts.'),
  category('signals', 'Signaux', 'radar', '#d97706', 'Surveille les sociétés liées et remonte les signaux d’achat.'),
  category('enrichment', 'Enrichissement', 'pencil', '#16a34a', 'Compléter les fiches existantes.'),
  category('verification', 'Vérification', 'shield-check', '#7c3aed', 'Contrôler l’exactitude des fiches.'),
  category('other', 'Autre', 'sparkles', '#0d9488', 'Une mission libre.'),
]

export const COMMON: Record<string, ApiReply> = {
  'GET /api/mission-categories': [200, CATEGORIES],
  'GET /api/mission-skills': [200, [{ id: 'skill-1', name: 'Sources fiables', description: null, content: 'Cite tes sources.', categories_count: 1, missions_count: 0 }]],
  'GET /api/missions/sources': [200, []],
  'GET /api/missions/proposals': [200, []],
  'GET /api/missions/options': [200, OPTIONS],
  'GET /api/missions/agents': [200, [{ id: 'agent-1', label: 'Agent claude-01', scopes: ['*'] }]],
}
