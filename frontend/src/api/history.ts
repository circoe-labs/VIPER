import { useInfiniteQuery } from '@tanstack/react-query'

import { apiGet } from './client'

// Mirrors backend/app/api/history.py: the readable history of a prospect or a company (Task 19). Entries are typed
// display data built by one backend formatter (backend/app/services/history.py) — French labels and formatted values,
// never raw audit JSON. Rules: doc/architecture/audit-and-provenance.md, *Visible history*.

export type ActorKind = 'human' | 'import' | 'system' | 'agent'
export type AuditSource = 'ui' | 'import' | 'database_explorer' | 'cli' | 'agent'

export interface HistoryActor {
  kind: ActorKind
  // A person's display name, an import's file name, a command or an agent label.
  label: string
  // The user id for a person, the batch id for an import…
  id: string | null
  // The person who confirmed an import's (or an agent's) work.
  on_behalf_of: string | null
}

export interface HistoryChange {
  label: string
  // An updated field has both (« — » for an empty side); an added or removed thing has one; a statement none.
  before: string | null
  after: string | null
}

export interface HistoryEntry {
  id: string
  occurred_at: string
  actor: HistoryActor
  source: AuditSource | null
  actions: string[]
  title: string
  // Value-free phrases (Home's feed).
  summary: string[]
  changes: HistoryChange[]
}

export interface HistoryPage {
  items: HistoryEntry[]
  next_cursor: string | null
}

export type HistorySubject = 'prospects' | 'companies'

export const HISTORY_PAGE_SIZE = 10

export const historyKeys = {
  all: ['history'] as const,
  subject: (subject: HistorySubject, id: string) => ['history', subject, id] as const,
}

// Newest first, HISTORY_PAGE_SIZE saves at a time; `fetchNextPage` reads the older ones (« Voir plus »).
export function useHistory(subject: HistorySubject, id: string) {
  return useInfiniteQuery({
    queryKey: historyKeys.subject(subject, id),
    queryFn: ({ pageParam, signal }) => {
      const params = new URLSearchParams({ limit: String(HISTORY_PAGE_SIZE) })
      if (pageParam) params.set('before', pageParam)
      return apiGet<HistoryPage>(`/${subject}/${encodeURIComponent(id)}/history?${params.toString()}`, signal)
    },
    initialPageParam: null as string | null,
    getNextPageParam: (page) => page.next_cursor,
  })
}
