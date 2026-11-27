// What the Contact page shows lives in the URL (`/contact?view=follow_ups&q=…&prospect=…`), like Prospection's criteria.ts:
// refresh, Back and deep links restore it. Defaults are omitted. `view` names the commercial list (commercialModel.ts);
// the former `section=CONTACTES` still opens the « contacted » list, so old bookmarks keep working.
import { CONTACTED, type ContactListCriteria } from '../api/contact'
import { TRACKING_STATUSES } from '../api/prospection'
import { CONTACT_VIEWS, type ContactViewKey } from './commercialModel'

export interface ContactView {
  // The commercial list shown (and given back when the workbench closes); null = the page default (`to_contact`).
  view: ContactViewKey | null
  // ISO week (`2026-W42`) of the « to contact » list; null = this week, overdue included.
  week: string | null
  q: string
  status: string | null
  company: string | null
  // The prospect's validation box: validated, uncertain, todo, ignored.
  validation: ValidationBox | null
  // The prospect open in the workbench.
  prospect: string | null
}

export const VALIDATION_BOXES = ['validated', 'uncertain', 'todo', 'ignored'] as const
export type ValidationBox = (typeof VALIDATION_BOXES)[number]

export const DEFAULT_VIEW: ContactView = { view: null, week: null, q: '', status: null, company: null, validation: null, prospect: null }

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// Hand-edited or stale URLs never break the page: anything malformed falls back to its default.
export function parseView(params: URLSearchParams): ContactView {
  const asked = params.get('view')
  const legacy = params.get('section')?.toUpperCase() === CONTACTED ? 'contacted' : null
  const week = params.get('week')
  const prospect = params.get('prospect')
  const company = params.get('company')
  const status = params.get('status')
  const validStatus = status !== null && (
    TRACKING_STATUSES.some((value) => status === `state:${value}`) ||
    /^level:(contact_pending|contact_sent|r1_sent|finished)$/.test(status)
  )
  return {
    view: CONTACT_VIEWS.find((key) => key === asked) ?? legacy,
    week: week !== null && /^\d{4}-W\d{2}$/.test(week) ? week : null,
    q: params.get('q') ?? '',
    status: validStatus ? status : null,
    company: company === 'none' || (company !== null && UUID.test(company)) ? company : null,
    validation: VALIDATION_BOXES.find((box) => box === params.get('validation')) ?? null,
    prospect: prospect !== null && UUID.test(prospect) ? prospect.toLowerCase() : null,
  }
}

export function serializeView(view: Partial<ContactView>): URLSearchParams {
  const full = { ...DEFAULT_VIEW, ...view }
  const params = new URLSearchParams()
  for (const key of Object.keys(DEFAULT_VIEW) as (keyof ContactView)[]) {
    const value = full[key]
    if (value !== DEFAULT_VIEW[key] && value !== null && value !== '') params.set(key, value)
  }
  return params
}

// The filters shared by every list and by the overview, under the search box.
export function listCriteria(view: ContactView): ContactListCriteria {
  return { section: view.view === 'contacted' ? CONTACTED : null, q: view.q.trim(), status: view.status, company: view.company, validation: view.validation }
}

export function contactHref(view: Partial<ContactView> = {}): string {
  const query = serializeView(view).toString()
  return `/contact${query ? `?${query}` : ''}`
}

// History state of a workbench opened from the list (and walked with « Précédent » / « Suivant », which replace their
// entry): « Retour à la liste » then goes back, so Back never reopens a prospect that was closed.
export const FROM_LIST = { fromList: true } as const

export function openedFromList(state: unknown): boolean {
  return typeof state === 'object' && state !== null && 'fromList' in state && state.fromList === true
}
