// The ONE place where a Home card learns where it leads. Slice 05 (navigation / deep-links) freezes the final query
// params of Prospection and Contact and updates this module only; HomePage and the cockpit adapter never build a URL.
//
// PROVISIONAL (removal condition: Slices 02/03 publish their final params, Slice 05 reconciles): `entity` (Prospection
// selector prospect|company|warehouse) and Contact's `status=` values are agreed in the task architecture but not yet
// consumed by the pages. `review` and `created_from` already exist in prospection/criteria.ts. /missions has no filter
// params yet, so the missions cards lead to the page itself rather than to an invented filter.

export type HomeCardId =
  | 'new_prospects'
  | 'new_companies'
  | 'new_warehouses'
  | 'appointments'
  | 'to_contact'
  | 'due'
  | 'to_verify'
  | 'missions_active'
  | 'missions_done'
  | 'reviews_pending'

export interface DestinationContext {
  // First day of the current week (ISO date) as reported by the dashboard.
  weekStart: string | undefined
}

function href(path: string, params: Record<string, string | undefined>): string {
  const query = new URLSearchParams(Object.entries(params).filter((entry): entry is [string, string] => entry[1] !== undefined))
  return query.size > 0 ? `${path}?${query.toString()}` : path
}

export const HOME_DESTINATIONS: Record<HomeCardId, (context: DestinationContext) => string> = {
  new_prospects: ({ weekStart }) => href('/prospection', { entity: 'prospect', created_from: weekStart }),
  new_companies: ({ weekStart }) => href('/prospection', { entity: 'company', created_from: weekStart }),
  new_warehouses: ({ weekStart }) => href('/prospection', { entity: 'warehouse', created_from: weekStart }),
  appointments: () => href('/contact', { status: 'appointment' }),
  to_contact: () => href('/contact', { status: 'to_contact' }),
  due: () => href('/contact', { status: 'due' }),
  to_verify: () => href('/prospection', { entity: 'prospect', review: 'to_verify' }),
  missions_active: () => '/missions',
  missions_done: () => '/missions',
  reviews_pending: () => '/missions',
}

// Header shortcuts (not KPI cards).
export const HOME_SHORTCUTS = { importExcel: '/prospection/import', prospection: '/prospection' } as const
