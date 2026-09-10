import type { ProspectListCriteria, ProspectPage } from '../api/prospection'

// The prospect queue behind « Enregistrer et suivant » (Task 15): the list order the user was working in when the
// editor opened. It keeps that order even when a save makes the saved prospect leave the segment (a verified person
// leaves « Jamais vérifiés »), so no one is skipped and no one is visited twice.

export interface QueueStep {
  id: string
  // 1-based list page the next prospect is on (the page the list should show behind the editor).
  page: number
}

export interface ProspectQueue {
  // Criteria of the list followed: segment, search, filters, sort.
  readonly criteria: ProspectListCriteria
  // Ids of the queue's current page in list order, that page, and the list total when it was read.
  readonly ids: readonly string[]
  readonly page: number
  readonly total: number
  // 1-based position of `id` in the whole list, or null when it is not on the current page.
  position(id: string): number | null
  // The prospect after `id`: the next one on the page; after the page's last one, the first prospect of a freshly
  // read page (same criteria) that was not on the current page — rows that left the list meanwhile shift the pages,
  // so the current page is read again before the next one. Null at the end of the list. Moves the queue to that page.
  next(id: string): Promise<QueueStep | null>
}

type FetchPage = (page: number) => Promise<ProspectPage>

export function createProspectQueue(
  criteria: ProspectListCriteria,
  start: { page: number; data: ProspectPage },
  fetchPage: FetchPage,
): ProspectQueue {
  let ids = start.data.items.map((row) => row.id)
  let page = start.page
  let total = start.data.total
  const pageSize = start.data.limit

  async function following(): Promise<QueueStep | null> {
    const seen = new Set(ids)
    for (let candidate = page; ; candidate += 1) {
      const data = await fetchPage(candidate)
      const fresh = data.items.find((row) => !seen.has(row.id))
      if (fresh) {
        ids = data.items.map((row) => row.id)
        page = candidate
        total = data.total
        return { id: fresh.id, page }
      }
      if (data.items.length < pageSize) return null
    }
  }

  return {
    criteria,
    get ids() {
      return ids
    },
    get page() {
      return page
    },
    get total() {
      return total
    },
    position(id) {
      const index = ids.indexOf(id)
      return index < 0 ? null : (page - 1) * pageSize + index + 1
    },
    next(id) {
      const index = ids.indexOf(id)
      if (index < 0) return Promise.resolve(ids[0] ? { id: ids[0], page } : null)
      const after = ids[index + 1]
      return after ? Promise.resolve({ id: after, page }) : following()
    },
  }
}
