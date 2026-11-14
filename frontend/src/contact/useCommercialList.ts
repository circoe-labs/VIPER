// Reads of the commercial lists (GET /contact/prospects, any category). Local to Contact: frontend/src/api/contact.ts
// (Slice 01) only types the « contacted » list; this reuses its `toRow`, page size and cache keys, so a message write
// refreshes these lists too (their keys sit under ['contact', 'page']).
import { keepPreviousData, useQuery } from '@tanstack/react-query'

import { apiGet } from '../api/client'
import { CONTACT_PAGE_SIZE, type ContactListCriteria, type ContactPage, contactKeys, toRow } from '../api/contact'
import { type ListPlan, currentMonday, keepRow } from './commercialModel'

export function commercialPath(plan: ListPlan, criteria: ContactListCriteria, limit: number, offset: number): `/${string}` {
  const params = new URLSearchParams({ category: plan.category, sort: plan.sort, limit: String(limit), offset: String(offset) })
  if (criteria.q.trim()) params.set('q', criteria.q.trim())
  if (criteria.company) params.set('company', criteria.company)
  if (criteria.status?.startsWith('state:')) params.set('tracking_status', criteria.status.slice(6))
  if (criteria.status?.startsWith('level:')) params.set('level', criteria.status.slice(6))
  if (plan.rank !== null) params.set('rank', String(plan.rank))
  if (plan.week) params.set('week', plan.week)
  return `/contact/prospects?${params.toString()}`
}

// `total` stays the server's count of the category; `items` are the rows kept by the view's client-side narrowing.
export function useCommercialList(plan: ListPlan, criteria: ContactListCriteria, page: number, currentWeek: string | undefined) {
  return useQuery({
    queryKey: [...contactKeys.all, 'page', 'commercial', plan, criteria, page, currentWeek ?? null],
    queryFn: async ({ signal }): Promise<ContactPage> => {
      const raw = await apiGet<ContactPage>(commercialPath(plan, criteria, CONTACT_PAGE_SIZE, (page - 1) * CONTACT_PAGE_SIZE), signal)
      const monday = currentMonday(currentWeek)
      return { ...raw, items: raw.items.map(toRow).filter((row) => keepRow(plan.key, row, monday)) }
    },
    placeholderData: keepPreviousData,
  })
}

// The order of the whole list, read once when the workbench opens (« Précédent » / « Suivant »), as api/contact.ts does.
const WALK_PAGE = 200
const WALK_MAX = 2000

export function useCommercialWalk(plan: ListPlan, criteria: ContactListCriteria, currentWeek: string | undefined, enabled: boolean) {
  return useQuery({
    queryKey: ['contact-walk', 'commercial', plan, criteria],
    queryFn: async ({ signal }) => {
      const monday = currentMonday(currentWeek)
      const ids: string[] = []
      for (let offset = 0; offset < WALK_MAX; offset += WALK_PAGE) {
        const page = await apiGet<ContactPage>(commercialPath(plan, criteria, WALK_PAGE, offset), signal)
        ids.push(...page.items.map(toRow).filter((row) => keepRow(plan.key, row, monday)).map((row) => row.id))
        if (offset + WALK_PAGE >= page.total) break
      }
      return ids
    },
    enabled,
    staleTime: Infinity,
    gcTime: 0,
    refetchOnWindowFocus: false,
  })
}
