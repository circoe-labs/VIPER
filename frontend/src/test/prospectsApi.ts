import { vi } from 'vitest'

import type { Company } from '../api/companies'
import type { HistoryEntry } from '../api/history'
import type { NoteInput, ProspectNote } from '../api/prospectNotes'
import type { Prospect, ProspectCreateInput, ProspectInput, Tracking, TrackingPatch } from '../api/prospects'
import type { Referent, TaxonomyValue } from '../api/settings'
import { isoWeekOf, weekMonday } from '../lib/isoWeek'
import { stubCompaniesApi } from './companiesApi'
import { historyPage } from './historyApi'
import { type FakeProspect, stubProspectionApi } from './prospectionApi'
import type { RecordedRequest } from './settingsApi'

// In-memory stand-in for /api/prospects (backend/app/api/routes/prospects.py) for component tests of the Prospect
// editor, on top of the Prospection, Companies and Settings fakes. It records every write and answers with a view
// rebuilt from the payload (verified_now → verified today); the server rules themselves are tested in the backend.
// Synthetic values only.

const STAMP = '2026-09-01T09:30:00+00:00'
export const TODAY = '2026-09-11'
let sequence = 0

export function prospectDetail(fields: Partial<Prospect> = {}): Prospect {
  sequence += 1
  return {
    id: `00000000-0000-7000-c000-${String(sequence).padStart(12, '0')}`,
    version: 'v1',
    civility: null,
    first_name: 'Jean',
    last_name: 'Exemple',
    company: null,
    role: null,
    exact_job_title: null,
    activity_status: 'unknown',
    employment_verified_at: null,
    verification_state: 'never_verified',
    employment_imported_unverified: false,
    contactability_status: 'contactable',
    do_not_contact_at: null,
    do_not_contact_reason: null,
    emails: [],
    phones: [],
    tracking: null,
    sources: [],
    import_row_count: 0,
    today: TODAY,
    stale_threshold_days: null,
    score: { total: 50, summary: 'Aucun signal enregistré.', band: 'yellow', contributions: [] },
    created_at: STAMP,
    updated_at: STAMP,
    ...fields,
  }
}

export function companySummary(company: Company): NonNullable<Prospect['company']> {
  return {
    id: company.id,
    display_name: company.display_name,
    legal_name: company.legal_name,
    siren: company.siren,
    email_domain: company.email_domain,
    website_url: company.website_url,
    commercial_segment_label: null,
    city: null,
    prospect_count: company.prospect_count,
  }
}

// `2026-09-14` → `2026-W38` (the API's week label).
function weekLabel(day: string | null): string | null {
  const week = day ? isoWeekOf(day) : null
  return week ? `${String(week.year)}-W${String(week.week).padStart(2, '0')}` : null
}

// Blank tracking with the API's fields (a test overrides what it needs).
export function trackingDetail(fields: Partial<Tracking> = {}): Tracking {
  return {
    status: 'neutral',
    planned_contact_on: null,
    planned_contact_week: null,
    response_received_on: null,
    appointment_on: null,
    appointment_time: null,
    referent: null,
    status_since: null,
    suggested_next_contact_on: null,
    suggested_next_contact_week: null,
    ...fields,
  }
}

// A note as the API answers it (synthetic).
export function noteDetail(fields: Partial<ProspectNote> = {}): ProspectNote {
  sequence += 1
  return {
    id: `00000000-0000-7000-d000-${String(sequence).padStart(12, '0')}`,
    prospect_id: '',
    fact_text: 'A liké notre post LinkedIn',
    noted_on: '2026-09-10',
    source_type: null,
    source_label: null,
    score_delta: null,
    created_at: STAMP,
    updated_at: STAMP,
    ...fields,
  }
}

// `noted_on` newest first, undated last (the API's order).
function sortedNotes(notes: ProspectNote[]): ProspectNote[] {
  return [...notes].sort((a, b) => (b.noted_on ?? '').localeCompare(a.noted_on ?? ''))
}

function reply(status: number, body?: unknown): Promise<Response> {
  if (status === 204) return Promise.resolve(new Response(null, { status }))
  const headers = { 'Content-Type': 'application/json' }
  return Promise.resolve(new Response(JSON.stringify(body), { status, headers }))
}

interface ProspectsStubOptions {
  details?: Prospect[]
  // Rows of the Prospection list (the page behind the editor).
  rows?: FakeProspect[]
  companies?: Company[]
  roles?: TaxonomyValue[]
  referents?: Referent[]
  // History entries per prospect id, newest first (none by default).
  histories?: Record<string, HistoryEntry[]>
  // Notes per prospect id (none by default).
  notes?: Record<string, ProspectNote[]>
}

export function stubProspectsApi(options: ProspectsStubOptions = {}) {
  const companies = stubCompaniesApi({ companies: options.companies ?? [] })
  const prospection = stubProspectionApi({
    prospects: options.rows ?? [],
    roles: options.roles ?? [],
    referents: options.referents ?? [],
  })
  const store = new Map((options.details ?? []).map((detail) => [detail.id, structuredClone(detail)]))
  const requests: RecordedRequest[] = []
  // Replaces the answer of the next write (e.g. a 409 or 422 the fake would not produce); `notesReply`, of the next
  // request to the notes.
  const next: { reply: [number, unknown] | null; notesReply: [number, unknown] | null } = { reply: null, notesReply: null }
  const notes = new Map(Object.entries(options.notes ?? {}).map(([id, list]) => [id, structuredClone(list)]))

  // The score the backend would compute from the notes (a stand-in: base 50, red < 40, yellow < 70; the real rules are
  // tested in the backend). A note write refreshes the stored prospect, as the real API's next read shows it.
  function rescore(prospectId: string) {
    const current = store.get(prospectId)
    if (!current) return
    const contributions = (notes.get(prospectId) ?? [])
      .filter((note) => note.score_delta !== null)
      .map((note) => ({
        id: note.id,
        delta: note.score_delta ?? 0,
        reason: note.fact_text,
        source_type: 'note',
        source_ref: note.id,
        created_at: note.created_at,
        origin: 'manual' as const,
      }))
    const total = Math.min(100, Math.max(0, 50 + contributions.reduce((sum, item) => sum + item.delta, 0)))
    const band = total < 40 ? 'red' : total < 70 ? 'yellow' : 'green'
    const summary = contributions.length === 0 ? 'Aucun signal enregistré.' : `${String(contributions.length)} signal(s) enregistré(s).`
    store.set(prospectId, { ...current, score: { total, summary, band, contributions } })
  }

  // /api/prospects/{id}/notes[/{note_id}]: the fake keeps the list per prospect and answers like the API.
  function handleNotes(method: string, prospectId: string, noteId: string | undefined, body: unknown): Promise<Response> {
    if (next.notesReply) {
      const [status, detail] = next.notesReply
      next.notesReply = null
      return reply(status, { detail })
    }
    const list = notes.get(prospectId) ?? []
    if (method === 'GET') return reply(200, sortedNotes(list))
    if (method === 'POST') {
      const input = body as NoteInput
      const created = noteDetail({
        prospect_id: prospectId,
        fact_text: input.fact_text,
        noted_on: input.noted_on ?? null,
        source_type: input.source_type ?? null,
        source_label: input.source_label ?? null,
        score_delta: input.score_delta ?? null,
      })
      notes.set(prospectId, [...list, created])
      rescore(prospectId)
      return reply(201, created)
    }
    const current = list.find((note) => note.id === noteId)
    if (!current) return reply(404, { detail: { code: 'not_found', message: 'Not found.' } })
    if (method === 'PATCH') {
      const updated: ProspectNote = { ...current, ...(body as NoteInput) }
      notes.set(prospectId, list.map((note) => (note.id === current.id ? updated : note)))
      rescore(prospectId)
      return reply(200, updated)
    }
    notes.set(prospectId, list.filter((note) => note.id !== current.id))
    rescore(prospectId)
    return reply(204)
  }

  function saved(previous: Prospect, input: ProspectInput): Prospect {
    const company = companies.store.find((row) => row.id === input.company_id)
    const verifiedAt = (now: boolean, stored: string | null) => (now ? `${TODAY}T10:00:00+00:00` : stored)
    const alias = <T extends { id: string }>(list: T[], id: string | null) => list.find((row) => row.id === id)
    return {
      ...previous,
      version: `${previous.version}+`,
      civility: input.civility,
      first_name: input.first_name,
      last_name: input.last_name,
      company: company ? companySummary(company) : null,
      exact_job_title: input.exact_job_title,
      activity_status: input.activity_status,
      role: input.role_label ? { id: 'role-cree', label: input.role_label, active: true } : previous.role,
      employment_verified_at: {
        keep: previous.employment_verified_at,
        verified_now: `${TODAY}T10:00:00+00:00`,
        verified_on: `${input.employment_verification.day ?? TODAY}T00:00:00+00:00`,
        clear: null,
      }[input.employment_verification.action],
      emails: input.emails.map((email, index) => ({
        id: email.id ?? `email-nouveau-${String(index)}`,
        address: email.address.toLowerCase(),
        is_primary: email.is_primary,
        is_active: email.is_active,
        verification_status: email.verified_now ? 'verified' : email.verification_status,
        last_verified_at: verifiedAt(email.verified_now, alias(previous.emails, email.id)?.last_verified_at ?? null),
        origin_type: alias(previous.emails, email.id)?.origin_type ?? 'manual',
        source_reference: email.source_reference,
        imported_unverified: false,
      })),
      phones: input.phones.map((phone, index) => ({
        id: phone.id ?? `phone-nouveau-${String(index)}`,
        number: phone.number.replace(/\s/g, ''),
        type: phone.type,
        is_primary: phone.is_primary,
        is_active: phone.is_active,
        verification_status: phone.verified_now ? 'verified' : phone.verification_status,
        last_verified_at: verifiedAt(phone.verified_now, alias(previous.phones, phone.id)?.last_verified_at ?? null),
        origin_type: alias(previous.phones, phone.id)?.origin_type ?? 'manual',
        source_reference: phone.source_reference,
        imported_unverified: false,
      })),
      tracking: input.tracking
        ? {
            ...input.tracking,
            planned_contact_week: weekLabel(input.tracking.planned_contact_on),
            referent: null,
            status_since: null,
            suggested_next_contact_on: null,
            suggested_next_contact_week: null,
          }
        : previous.tracking,
    }
  }

  function handle(method: string, url: URL, body: unknown): Promise<Response> {
    const [, , , id, action, noteId] = url.pathname.split('/')
    if (id && action === 'notes') return handleNotes(method, id, noteId, body)
    if (method !== 'GET' && next.reply) {
      const [status, detail] = next.reply
      next.reply = null
      return reply(status, { detail })
    }
    if (method === 'POST' && !id) {
      const created = saved(prospectDetail({ version: 'v1' }), body as ProspectCreateInput)
      store.set(created.id, created)
      return reply(201, created)
    }
    const current = id ? store.get(id) : undefined
    if (!current) return reply(404, { detail: { code: 'not_found', message: 'Not found.' } })
    if (method === 'GET' && action === 'history') return reply(200, historyPage(options.histories?.[current.id] ?? [], url))
    if (method === 'GET') return reply(200, current)
    if (method === 'PUT' && action === 'contactability') {
      const { do_not_contact, reason } = body as { do_not_contact: boolean; reason: string }
      const updated: Prospect = {
        ...current,
        version: `${current.version}+`,
        contactability_status: do_not_contact ? 'do_not_contact' : 'contactable',
        do_not_contact_at: do_not_contact ? `${TODAY}T10:00:00+00:00` : null,
        do_not_contact_reason: do_not_contact ? reason : null,
      }
      store.set(current.id, updated)
      return reply(200, updated)
    }
    if (method === 'PATCH' && action === 'tracking') {
      // State and/or week only; the Contact rules themselves are tested in the backend.
      const patch = body as TrackingPatch
      const tracking = current.tracking ?? trackingDetail()
      const planned =
        patch.next_action_week === undefined
          ? tracking.planned_contact_on
          : patch.next_action_week && weekMonday(patch.next_action_week)
      const updated: Prospect & { cancelled_messages: number; in_flight_messages: number } = {
        ...current,
        version: `${current.version}+`,
        cancelled_messages: 0,
        in_flight_messages: 0,
        tracking: {
          ...tracking,
          status: patch.status ?? tracking.status,
          planned_contact_on: planned,
          planned_contact_week: weekLabel(planned),
        },
      }
      store.set(current.id, updated)
      return reply(200, updated)
    }
    if (method === 'PUT') {
      const updated = saved(current, body as ProspectInput)
      store.set(current.id, updated)
      return reply(200, updated)
    }
    if (method === 'DELETE') {
      if (current.contactability_status === 'do_not_contact') {
        return reply(409, { detail: { code: 'do_not_contact', message: 'Blocked.' } })
      }
      store.delete(current.id)
      return reply(204)
    }
    return reply(405, { detail: 'Method Not Allowed' })
  }

  const fetchMock = vi.fn((input: string, init?: RequestInit) => {
    const url = new URL(input, 'http://localhost')
    if (url.pathname.startsWith('/api/prospects')) {
      const method = init?.method ?? 'GET'
      const body: unknown = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined
      requests.push({ method, path: url.pathname, search: url.search, body })
      return handle(method, url, body)
    }
    if (url.pathname.startsWith('/api/companies')) return companies.fetchMock(input, init)
    return prospection.fetchMock(input, init)
  })
  vi.stubGlobal('fetch', fetchMock)
  return { store, requests, next, notes, companies: companies.store }
}

// Body of the last `method` request to a prospect path.
export function lastBody(requests: RecordedRequest[], method: string): unknown {
  const request = requests.filter((item) => item.method === method).at(-1)
  if (!request) throw new Error(`No ${method} request was sent.`)
  return request.body
}
