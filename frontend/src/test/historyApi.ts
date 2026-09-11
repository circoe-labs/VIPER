import type { HistoryEntry, HistoryPage } from '../api/history'
import { TEST_USER } from './render'

// Synthetic history entries (backend/app/services/history.py builds the real ones) and the paging of
// GET /api/{prospects|companies}/{id}/history for the component-test fakes.

let sequence = 0

export function historyEntry(fields: Partial<HistoryEntry> = {}): HistoryEntry {
  sequence += 1
  return {
    id: `00000000-0000-7000-d000-${String(sequence).padStart(12, '0')}`,
    occurred_at: '2026-09-10T08:30:00+00:00',
    actor: { kind: 'human', label: TEST_USER.display_name, id: TEST_USER.id, on_behalf_of: null },
    source: 'ui',
    actions: ['prospect.updated'],
    title: 'Fiche modifiée',
    summary: ['Nom modifié'],
    changes: [{ label: 'Nom', before: 'Exemple', after: 'Martin' }],
    ...fields,
  }
}

// One page of `entries` (newest first) after the `before` cursor, `limit` long.
export function historyPage(entries: HistoryEntry[], url: URL): HistoryPage {
  const limit = Number(url.searchParams.get('limit') ?? 10)
  const before = url.searchParams.get('before')
  const start = before ? entries.findIndex((entry) => entry.id === before) + 1 : 0
  const items = entries.slice(start, start + limit)
  const more = start + limit < entries.length
  return { items, next_cursor: more ? (items.at(-1)?.id ?? null) : null }
}
