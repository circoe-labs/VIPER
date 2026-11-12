import type { ProposalItem, ResultView } from '../api/agents'
import type { MissionResultCard, MissionResultPage } from '../api/missions'

// Synthetic answers of the review endpoints for component tests (Slice 08).

export const RESULT_ID = '00000000-0000-7000-e000-000000000050'
export const TASK_ID = '00000000-0000-7000-e000-000000000030'

export function item(overrides: Partial<ProposalItem> = {}): ProposalItem {
  return {
    key: 'website_url',
    field: 'website_url',
    label: 'Site web',
    before: null,
    after: 'https://2sn.example',
    status: 'add',
    source: 'https://registre.example/2sn',
    quote: null,
    confidence: 90,
    source_published_at: '2026-09-12',
    source_checked_at: '2026-11-10T09:31:00+00:00',
    ...overrides,
  }
}

export function resultView(overrides: Partial<ResultView> = {}): ResultView {
  return {
    id: RESULT_ID,
    task_id: TASK_ID,
    task_type: 'update_company',
    task_status: 'submitted',
    status: 'pending_review',
    submitted_at: '2026-11-10T09:30:00+00:00',
    submitted_by_label: 'Agent claude-01',
    digest: 'a'.repeat(64),
    raw: { notes: 'Rapport brut' },
    proposal: {
      kind: 'update_company',
      items: [
        item(),
        item({ key: 'email_domain', field: 'email_domain', label: 'Domaine e-mail', after: '2sn.example', confidence: 55, source: 'https://annuaire.example/2sn', source_published_at: '2019-03-01' }),
      ],
      refused: [{ field: 'siren', label: 'SIREN', reason: 'invalid', message: 'SIREN invalide' }],
      stale: false,
      confidence: 88,
      notes: 'Deux sources concordantes trouvées.',
    },
    accepted_items: null,
    applied: null,
    decision_note: null,
    decided_at: null,
    decided_by_display: null,
    company_name: '2SN',
    prospect_name: null,
    ...overrides,
  }
}

// A result stored before Slice 02: no confidence, dates or notes on the items.
export function historicalResult(): ResultView {
  const old = item({ source: null })
  delete old.confidence
  delete old.source_published_at
  delete old.source_checked_at
  const legacy = item({ key: 'phone', field: 'phone', label: 'Téléphone', after: '02 31 00 00 00' })
  delete legacy.confidence
  delete legacy.source_published_at
  delete legacy.source_checked_at
  return resultView({
    raw: {},
    proposal: { kind: 'update_company', items: [old, legacy], refused: [], stale: false, confidence: 70, notes: null },
  })
}

export function resultCard(overrides: Partial<MissionResultCard> = {}): MissionResultCard {
  return {
    id: RESULT_ID,
    task_id: TASK_ID,
    run_id: '00000000-0000-7000-e000-000000000020',
    task_type: 'update_company',
    status: 'pending_review',
    agent_id: 'agent-1',
    agent_label: 'Agent claude-01',
    subject_label: '2SN',
    summary: 'Société confirmée sur deux sources.',
    confidence: 88,
    items_count: 4,
    refused_count: 1,
    sources_count: 2,
    submitted_at: new Date(Date.now() - 5 * 60_000).toISOString(),
    decided_at: null,
    decided_by: null,
    ...overrides,
  }
}

export function resultPage(items: MissionResultCard[], overrides: Partial<MissionResultPage> = {}): MissionResultPage {
  return {
    items,
    total: items.length,
    limit: 12,
    offset: 0,
    status_counts: { pending_review: items.length, accepted: 2, rejected: 1, superseded: 0 },
    ...overrides,
  }
}
