// Contact as a commercial mailing view: which list a capsule opens, and the figures the capsules show.
//
// IMPLEMENTING NEW LOGIC - commercial capsules: Contact used to show one list (« contacted »). The planning the backend
// already serves (GET /contact/dashboard categories + to_send, GET /contact/prospects?category=…) answers the other
// questions (to contact, follow-ups, replies, appointments, mail errors); this module only maps it, it counts nothing.
//
// The capsule figures come through `ContactSummarySource`, a local adapter shape: `categories`/`weeks` are in the shared
// `ContactDashboard` type already; `to_send` is sent by the backend (ContactDashboardOut.to_send) but not yet typed
// there. Slice 01 owns frontend/src/api/*: once it types `to_send`, `readSummarySource` is a plain pass-through. A figure the
// source does not carry is `null` and rendered « — », never a guess. Deliberately NOT shown: quotes/opportunities (no
// contract) and « inactive » prospects (no counter; `activity_status` exists per row only).
import type { ContactDashboard, ContactRow, ContactWeekOption } from '../api/contact'
import { mondayLabel, parseIsoWeek, weekBadgeLabel, weekMonday } from '../lib/isoWeek'
import type { ContactView } from './criteria'

// URL values of `?view=`; Home links to them (doc/features/contact.md, « Commercial views »).
export const CONTACT_VIEWS = [
  'to_contact',
  'follow_ups',
  'overdue',
  'contacted',
  'responses',
  'appointments',
  'mail_errors',
] as const
export type ContactViewKey = (typeof CONTACT_VIEWS)[number]
export const DEFAULT_VIEW_KEY: ContactViewKey = 'to_contact'

// `?category=` values of GET /contact/prospects used here.
export type ContactListCategory = 'to_send' | 'contacted' | 'response_received' | 'appointment_obtained' | 'email_error'

export interface ViewMeta {
  label: string
  title: string
  empty: string
  category: ContactListCategory
  // Server-side narrowing: 0 = first contact only.
  rank?: number
  // The server has no such category: the rows of `to_send` are narrowed here (see `keepRow`).
  clientFilter?: 'follow_ups' | 'overdue'
  sort: 'due' | 'company'
  tone: 'info' | 'warning' | 'danger' | 'success' | 'neutral'
  // The list is a plan (a next step and a date), not a history.
  planning: boolean
}

export const VIEW_META: Record<ContactViewKey, ViewMeta> = {
  to_contact: { label: 'À contacter', title: 'Prospects à contacter', empty: 'Aucun prospect à contacter sur cette période.', category: 'to_send', rank: 0, sort: 'due', tone: 'info', planning: true },
  follow_ups: { label: 'Relances à faire', title: 'Relances à faire cette semaine', empty: 'Aucune relance à faire cette semaine.', category: 'to_send', clientFilter: 'follow_ups', sort: 'due', tone: 'info', planning: true },
  overdue: { label: 'En retard', title: 'Envois en retard', empty: 'Aucun envoi en retard.', category: 'to_send', clientFilter: 'overdue', sort: 'due', tone: 'warning', planning: true },
  contacted: { label: 'Contactés', title: 'Prospects contactés', empty: 'Aucun prospect contacté pour le moment.', category: 'contacted', sort: 'company', tone: 'neutral', planning: false },
  responses: { label: 'Réponses', title: 'Réponses reçues', empty: 'Aucune réponse reçue pour le moment.', category: 'response_received', sort: 'company', tone: 'success', planning: false },
  appointments: { label: 'RDV pris', title: 'Rendez-vous obtenus', empty: 'Aucun rendez-vous obtenu pour le moment.', category: 'appointment_obtained', sort: 'company', tone: 'success', planning: false },
  mail_errors: { label: 'Erreurs mail', title: 'Adresses e-mail en erreur', empty: 'Aucune adresse e-mail en erreur.', category: 'email_error', sort: 'company', tone: 'danger', planning: false },
}

export function activeView(view: Pick<ContactView, 'view'>): ContactViewKey {
  return view.view ?? DEFAULT_VIEW_KEY
}

// What to ask the server for one view; only `to_contact` takes a week.
export interface ListPlan {
  key: ContactViewKey
  category: ContactListCategory
  rank: number | null
  week: string | null
  sort: 'due' | 'company'
}

export function listPlan(view: Pick<ContactView, 'view' | 'week'>): ListPlan {
  const key = activeView(view)
  const meta = VIEW_META[key]
  return { key, category: meta.category, rank: meta.rank ?? null, week: key === 'to_contact' ? view.week : null, sort: meta.sort }
}

// The business day (Europe/Paris) of an instant: the backend weeks are Paris weeks.
const PARIS_DAY = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Paris' })

export function parisDay(iso: string): string | null {
  const date = new Date(iso)
  return Number.isNaN(date.getTime()) ? null : PARIS_DAY.format(date)
}

export function currentMonday(currentWeek: string | undefined): string | null {
  const week = parseIsoWeek(currentWeek)
  return week ? weekMonday(week) : null
}

// Follow-ups = `to_send` rows past the first contact; overdue = due before this week's Monday (backend `overdue_before`).
export function keepRow(key: ContactViewKey, row: ContactRow, monday: string | null): boolean {
  const filter = VIEW_META[key].clientFilter
  if (filter === 'follow_ups') return row.next_step !== null && row.next_step !== 'contact'
  if (filter === 'overdue') {
    const due = row.planned_contact_at ? parisDay(row.planned_contact_at) : null
    return due !== null && monday !== null && due < monday
  }
  return true
}

// --- figures -----------------------------------------------------------------------------------------------------

export interface ContactSummarySource {
  current_week: string
  weeks: ContactWeekOption[]
  categories?: { category: string; count: number }[]
  to_send?: { total: number; overdue: number; groups: { rank: number; count: number; overdue: number }[] }
}

// `ContactDashboard` is structurally a `ContactSummarySource`. `to_send` is on the wire (backend ContactDashboardOut)
// but absent from the shared type until Slice 01 adds it: it is read at runtime and `undefined` (« — ») if missing.
export function readSummarySource(data: ContactDashboard | undefined): ContactSummarySource | undefined {
  return data
}

export interface Capsule {
  key: ContactViewKey
  label: string
  tone: ViewMeta['tone']
  // null = the source does not carry it: rendered « — ».
  count: number | null
  // « dont 3 en retard », only when the source gives it.
  hint: string | null
}

function categoryCount(source: ContactSummarySource | undefined, name: string): number | null {
  return source?.categories?.find((entry) => entry.category === name)?.count ?? null
}

export function buildCapsules(source: ContactSummarySource | undefined): Capsule[] {
  const sent = source?.to_send
  const first = sent?.groups.find((group) => group.rank === 0)
  const followUps = sent && first ? sent.total - first.count : null
  const followUpsLate = sent && first ? sent.overdue - first.overdue : null
  const late = (count: number | null | undefined) => (count ? `dont ${String(count)} en retard` : null)
  const counts: Record<ContactViewKey, { count: number | null; hint: string | null }> = {
    to_contact: { count: first?.count ?? null, hint: late(first?.overdue) },
    follow_ups: { count: followUps, hint: late(followUpsLate) },
    overdue: { count: sent?.overdue ?? null, hint: null },
    contacted: { count: categoryCount(source, 'contacted'), hint: null },
    responses: { count: categoryCount(source, 'response_received'), hint: null },
    appointments: { count: categoryCount(source, 'appointment_obtained'), hint: null },
    mail_errors: { count: categoryCount(source, 'email_error'), hint: null },
  }
  return CONTACT_VIEWS.map((key) => ({ key, label: VIEW_META[key].label, tone: VIEW_META[key].tone, ...counts[key] }))
}

export interface WeekChoice {
  week: string
  label: string
  count: number
}

// The weeks still to come with something planned (this week included): « S42 · lun. 12 oct. ».
export function upcomingWeeks(source: ContactSummarySource | undefined): WeekChoice[] {
  if (!source) return []
  return source.weeks
    .filter((option) => option.week >= source.current_week && option.count > 0)
    .map((option) => {
      const parsed = parseIsoWeek(option.week)
      return { week: option.week, count: option.count, label: parsed ? `${weekBadgeLabel(parsed)} · ${mondayLabel(parsed)}` : option.week }
    })
}
