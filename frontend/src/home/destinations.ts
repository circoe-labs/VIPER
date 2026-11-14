// The ONE place where a Home card learns where it leads. HomePage and the cockpit adapter never build a URL.
//
// FROZEN query params (Slice 05), each consumed by the destination page and URL-serialised by its criteria module:
//  - Contact (`contact/criteria.ts`, `contact/commercialModel.ts`): `view=to_contact|follow_ups|overdue|contacted|responses|
//    appointments|mail_errors`, optional `week=YYYY-Www`. NOT `status=` (that is a tracking-state filter of the page).
//  - Prospection (`prospection/criteria.ts`): `entity=company|warehouse` (prospect is the default and is spelled out only
//    for readability), `created_from` / `created_to` (prospects and companies only), `review=to_verify|…`,
//    `warehouse_category`, `warehouse_to_contact`.
// The Entrepôts list has no creation-date filter (GET /warehouses takes none), so « Nouveaux entrepôts » leads to the
// warehouse list unfiltered rather than to a list that pretends to be filtered. /missions has no filter params yet.

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
  // First day of the current week (ISO date) as reported by GET /api/metrics/weekly.
  weekStart: string | undefined
}

function href(path: string, params: Record<string, string | undefined>): string {
  const query = new URLSearchParams(Object.entries(params).filter((entry): entry is [string, string] => entry[1] !== undefined))
  return query.size > 0 ? `${path}?${query.toString()}` : path
}

export const HOME_DESTINATIONS: Record<HomeCardId, (context: DestinationContext) => string> = {
  new_prospects: () => href('/prospection', { entity: 'prospect' }),
  new_companies: () => href('/prospection', { entity: 'company' }),
  new_warehouses: () => href('/prospection', { entity: 'warehouse' }),
  appointments: () => href('/contact', { view: 'appointments' }),
  to_contact: () => href('/contact', { view: 'to_contact' }),
  due: () => href('/contact', { view: 'follow_ups' }),
  to_verify: () => href('/prospection', { entity: 'prospect', review: 'to_verify' }),
  missions_active: () => '/missions',
  missions_done: () => '/missions',
  reviews_pending: () => '/missions',
}

// Header shortcuts (not KPI cards).
export const HOME_SHORTCUTS = { importExcel: '/prospection/import', prospection: '/prospection' } as const
