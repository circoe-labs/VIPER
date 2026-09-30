// What the Contact page shows lives in the URL (`/contact?counter=to_handle&week=all&prospect=…`), like Prospection's
// criteria.ts: refresh, Back and deep links restore it. Defaults are omitted.
import {
  CONTACT_COUNTERS,
  type ContactCounter,
  type ContactListCriteria,
  type ContactState,
} from '../api/contact'
import { TRACKING_STATUSES } from '../api/prospection'

// « Cette semaine » (the server's `current_week`, the default), every week, or one ISO week `2026-W41`.
export type WeekChoice = 'current' | 'all' | `${number}-W${number}`

export interface ContactView {
  counter: ContactCounter | null
  week: WeekChoice
  state: ContactState | null
  q: string
  page: number
  // The prospect open in the workbench.
  prospect: string | null
}

export const DEFAULT_VIEW: ContactView = { counter: null, week: 'current', state: null, q: '', page: 1, prospect: null }

export const CONTACT_STATES: readonly ContactState[] = TRACKING_STATUSES.filter(
  (status): status is ContactState => status !== 'ignored',
)

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const WEEK = /^\d{4}-W\d{2}$/

function oneOf<T extends string>(values: readonly T[], raw: string | null): T | null {
  return raw !== null && (values as readonly string[]).includes(raw) ? (raw as T) : null
}

function weekChoice(raw: string | null): WeekChoice {
  if (raw === 'all') return 'all'
  return raw !== null && WEEK.test(raw) ? (raw as WeekChoice) : 'current'
}

// Hand-edited or stale URLs never break the page: anything malformed falls back to its default.
export function parseView(params: URLSearchParams): ContactView {
  const page = Number(params.get('page'))
  const prospect = params.get('prospect')
  return {
    counter: oneOf(CONTACT_COUNTERS, params.get('counter')),
    week: weekChoice(params.get('week')),
    state: oneOf(CONTACT_STATES, params.get('state')),
    q: params.get('q') ?? '',
    page: Number.isInteger(page) && page > 0 ? page : 1,
    prospect: prospect !== null && UUID.test(prospect) ? prospect.toLowerCase() : null,
  }
}

export function serializeView(view: Partial<ContactView>): URLSearchParams {
  const full = { ...DEFAULT_VIEW, ...view }
  const params = new URLSearchParams()
  for (const key of Object.keys(DEFAULT_VIEW) as (keyof ContactView)[]) {
    const value = full[key]
    if (value !== DEFAULT_VIEW[key] && value !== null && value !== '') params.set(key, String(value))
  }
  return params
}

// The list request of a view; « cette semaine » is the server's current week (the API has no default week), null
// while it is not known yet.
export function listCriteria(view: ContactView, currentWeek: string | undefined): ContactListCriteria | null {
  if (view.week === 'current' && !currentWeek) return null
  return {
    counter: view.counter,
    week: view.week === 'all' ? null : view.week === 'current' ? (currentWeek ?? null) : view.week,
    state: view.state,
    q: view.q.trim(),
  }
}

// A counter card opens its whole set: its own window (overdue weeks included) and every state, not the selectors', so
// the card always equals the list; the week goes to « Toutes les semaines » and the state to « Tous les états » (both
// can still narrow afterwards). Pressing the active card again returns to the default planning (this week).
export function selectCounter(view: ContactView, counter: ContactCounter): Partial<ContactView> {
  return view.counter === counter
    ? { counter: null, week: 'current', page: 1 }
    : { counter, week: 'all', state: null, page: 1 }
}

// Criteria that narrow the list besides the counter (shown as « Réinitialiser »).
export function hasFilters(view: ContactView): boolean {
  return view.counter !== null || view.week !== 'current' || view.state !== null || view.q.trim() !== ''
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
