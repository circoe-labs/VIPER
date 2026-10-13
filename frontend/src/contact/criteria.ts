// What the Contact page shows lives in the URL (`/contact?section=S40&prospect=…`), like Prospection's criteria.ts:
// refresh, Back and deep links restore it. Defaults are omitted.
import { CONTACT_SECTIONS, type ContactListCriteria, type ContactSection } from '../api/contact'

export interface ContactView {
  // The section a prospect was opened from: closing the workbench gives that section back, open.
  section: ContactSection | null
  q: string
  // The prospect open in the workbench.
  prospect: string | null
}

export const DEFAULT_VIEW: ContactView = { section: null, q: '', prospect: null }

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// Hand-edited or stale URLs never break the page: anything malformed falls back to its default.
export function parseView(params: URLSearchParams): ContactView {
  const section = params.get('section')?.toUpperCase() ?? null
  const prospect = params.get('prospect')
  return {
    section: CONTACT_SECTIONS.find((code) => code === section) ?? null,
    q: params.get('q') ?? '',
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

// The list of one section under the search box.
export function listCriteria(view: ContactView, section: ContactSection | null = view.section): ContactListCriteria {
  return { section, q: view.q.trim() }
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
