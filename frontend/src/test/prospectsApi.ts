import { vi } from 'vitest'

import type { Company } from '../api/companies'
import type { HistoryEntry } from '../api/history'
import type { ContactProgress, Prospect, ProspectCreateInput, ProspectInput, Tracking, TrackingPatch } from '../api/prospects'
import type { Place, ProspectSequences, QualityAlert, Sequence } from '../api/sequences'
import type { Cohort, Referent, TaxonomyValue } from '../api/settings'
import { stubCompaniesApi } from './companiesApi'
import { historyPage } from './historyApi'
import { type FakeProspect, stubProspectionApi } from './prospectionApi'
import type { RecordedRequest } from './settingsApi'

// In-memory stand-in for /api/prospects (backend/app/api/routes/prospects.py) for component tests of the Prospect
// editor, on top of the Prospection, Companies and Settings fakes. It records every write and answers with a view
// rebuilt from the payload (verified_now → verified today); the server rules themselves are tested in the backend.
// It also plays the prospect's sequences (`…/sequences`, `…/cohort`, `…/messages/mark-sent`) and its quality alerts
// (`/api/alerts`) with their main refusals (`sequence_changed`, `rank_not_next`, `ignored_is_terminal`,
// `prospect_do_not_contact`, `alert_exists`). Synthetic values only.

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
    contact: contactProgress(),
    sources: [],
    import_row_count: 0,
    today: TODAY,
    stale_threshold_days: null,
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

// Blank tracking with the API's fields (a test overrides what it needs).
export function trackingDetail(fields: Partial<Tracking> = {}): Tracking {
  return {
    status: 'neutral',
    response_received_on: null,
    appointment_on: null,
    appointment_time: null,
    referent: null,
    status_since: null,
    ...fields,
  }
}

// Where a prospect stands (the prospect view's `contact`); without cohort by default.
export function contactProgress(fields: Partial<ContactProgress> = {}): ContactProgress {
  return {
    cohort: null,
    sequence_open: false,
    sent_count: 0,
    level_label: null,
    level: null,
    next_step: null,
    finished: false,
    next_due_on: null,
    next_due_week: null,
    pause_reason: 'no_cohort',
    email_error: false,
    max_follow_ups: 4,
    ...fields,
  }
}

const LEVELS = ['contact_pending', 'contact_sent']

// The place of a sequence in `cohort` after `sent` sends (max relances 4), due on `due` (a past day by default).
export function placeIn(cohort: Cohort, sent = 0, fields: Partial<Place> = {}): Place {
  const finished = sent > 4
  return {
    cohort: { id: cohort.id, code: cohort.code, starts_on: cohort.starts_on, out_of_campaign: cohort.out_of_campaign, needs_review: false },
    sequence_id: `sequence-${cohort.code}`,
    sequence_open: true,
    sent_count: sent,
    level_label: finished ? 'Relance terminée' : sent === 0 ? 'Contact' : `R${String(sent)}`,
    level: finished ? 'finished' : (LEVELS[sent] ?? `r${String(sent - 1)}_sent`),
    next_step: finished ? null : sent === 0 ? 'contact' : `r${String(sent)}`,
    finished,
    next_due_at: null,
    next_due_on: cohort.out_of_campaign || finished ? null : (cohort.starts_on ?? null),
    next_due_week: null,
    pause_reason: cohort.out_of_campaign ? 'out_of_campaign' : finished ? 'finished' : null,
    email_error: false,
    max_follow_ups: 4,
    ...fields,
  }
}

// One sequence of the history, from its place.
export function sequenceOf(place: Place, fields: Partial<Sequence> = {}): Sequence {
  if (!place.cohort) throw new Error('A sequence needs a cohort.')
  return {
    id: place.sequence_id ?? 'sequence',
    cohort: place.cohort,
    is_current: true,
    opened_at: '2026-09-01T08:00:00+00:00',
    closed_at: null,
    end_reason: null,
    sent_count: place.sent_count,
    messages: Array.from({ length: place.sent_count }, (_, rank) => ({
      message_id: `${place.sequence_id ?? 'sequence'}-${String(rank)}`,
      rank,
      step: rank === 0 ? 'contact' : `r${String(rank)}`,
      step_label: rank === 0 ? 'Contact' : `R${String(rank)}`,
      status: 'sent' as const,
      sent_at: '2026-09-07T08:00:00+00:00',
      sent_source: 'import' as const,
      has_content: false,
    })),
    ...fields,
  }
}

export function qualityAlert(fields: Partial<QualityAlert> = {}): QualityAlert {
  sequence += 1
  return {
    id: `00000000-0000-7000-e000-${String(sequence).padStart(12, '0')}`,
    prospect_id: null,
    company_id: null,
    type: 'function_to_check',
    source: 'human',
    note: null,
    detail: {},
    raised_by_type: 'human',
    raised_by: 'Opératrice Test',
    raised_at: '2026-09-08T09:00:00+00:00',
    open: true,
    resolved_at: null,
    resolved_by: null,
    resolution_note: null,
    ...fields,
  }
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
  // Paramètres › Cohortes (S0 is always there when not given).
  cohorts?: Cohort[]
  // The sequences of a prospect id (default: none, from its `contact`).
  sequences?: Record<string, Pick<ProspectSequences, 'place' | 'sequences'>>
  alerts?: QualityAlert[]
}

export function stubProspectsApi(options: ProspectsStubOptions = {}) {
  const companies = stubCompaniesApi({ companies: options.companies ?? [] })
  const prospection = stubProspectionApi({
    prospects: options.rows ?? [],
    roles: options.roles ?? [],
    referents: options.referents ?? [],
    ...(options.cohorts ? { cohorts: options.cohorts } : {}),
  })
  const sequences = new Map(Object.entries(structuredClone(options.sequences ?? {})))
  const alerts: QualityAlert[] = structuredClone(options.alerts ?? [])
  const store = new Map((options.details ?? []).map((detail) => [detail.id, structuredClone(detail)]))
  const requests: RecordedRequest[] = []
  // Replaces the answer of the next write (e.g. a 409 or 422 the fake would not produce).
  const next: { reply: [number, unknown] | null } = { reply: null }

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
      tracking: input.tracking ? { ...input.tracking, referent: null, status_since: null } : previous.tracking,
    }
  }

  function refusal(status: number, code: string, extra: Record<string, unknown> = {}): Promise<Response> {
    return reply(status, { detail: { code, message: 'Refused.', ...extra } })
  }

  function placeOf(current: Prospect): { place: Place; sequences: Sequence[] } {
    const known = sequences.get(current.id)
    if (known) return known
    return { place: { ...current.contact, sequence_id: null, next_due_at: null }, sequences: [] }
  }

  // The prospect's derived `contact` follows its place (a new version, as every write of the server).
  function placed(current: Prospect, next: { place: Place; sequences: Sequence[] }, fields: Partial<Prospect> = {}) {
    sequences.set(current.id, next)
    const { place } = next
    const contact = contactProgress({
      cohort: place.cohort,
      sequence_open: place.sequence_open,
      sent_count: place.sent_count,
      level_label: place.level_label,
      level: place.level,
      next_step: place.next_step,
      finished: place.finished,
      next_due_on: place.next_due_on,
      pause_reason: place.pause_reason,
      email_error: place.email_error,
    })
    const updated = { ...current, version: `${current.version}+`, contact, ...fields }
    store.set(current.id, updated)
    return updated
  }

  function changeCohort(current: Prospect, cohortId: string | null): Promise<Response> {
    if (current.tracking?.status === 'ignored') return refusal(409, 'ignored_is_terminal')
    if (current.contactability_status === 'do_not_contact') return refusal(409, 'prospect_do_not_contact')
    const before = placeOf(current)
    const target = prospection.settings.contact.cohorts.find((cohort) => cohort.id === cohortId) ?? null
    if (cohortId !== null && !target) return refusal(404, 'not_found')
    const closed = before.sequences.map((item) =>
      item.is_current
        ? { ...item, is_current: false, closed_at: `${TODAY}T10:00:00+00:00`, end_reason: target ? ('cohort_changed' as const) : ('cohort_removed' as const) }
        : item,
    )
    const status = current.tracking?.status
    const resumed = target && status && ['response_received', 'appointment_obtained', 'disqualified'].includes(status) ? status : null
    const place: Place = target
      ? { ...placeIn(target, 0, { sequence_id: `sequence-${target.code}-${String(closed.length + 1)}` }), email_error: before.place.email_error }
      : { ...before.place, cohort: null, sequence_id: null, sequence_open: false, sent_count: 0, level: null, level_label: null, next_step: null, next_due_on: null, pause_reason: 'no_cohort' }
    const history = target ? [{ ...sequenceOf(place), opened_at: `${TODAY}T10:00:00+00:00` }, ...closed] : closed
    placed(current, { place, sequences: history }, resumed && current.tracking ? { tracking: { ...current.tracking, status: 'neutral' } } : {})
    return reply(200, { place, changed: true, resumed_from: resumed, cancelled_messages: 0, in_flight_messages: 0 })
  }

  function markSent(current: Prospect, input: { rank: number; sequence_id?: string; sent_at?: string }): Promise<Response> {
    const { place, sequences: history } = placeOf(current)
    if (!place.sequence_open || place.sequence_id === null) return refusal(409, 'no_open_sequence')
    if (input.sequence_id !== undefined && input.sequence_id !== place.sequence_id) {
      return refusal(409, 'sequence_changed', { sequence_id: place.sequence_id })
    }
    if (input.rank !== place.sent_count) return refusal(409, 'rank_not_next', { next_rank: place.sent_count })
    if (!place.cohort) return refusal(409, 'no_open_sequence')
    const cohort = { ...place.cohort, current_count: 0, sequence_count: 1 }
    const next = placeIn(cohort, place.sent_count + 1, { sequence_id: place.sequence_id, next_due_on: '2026-09-14' })
    const sentAt = input.sent_at ?? `${TODAY}T10:00:00+00:00`
    const updated = history.map((item) =>
      item.id === place.sequence_id
        ? {
            ...item,
            sent_count: next.sent_count,
            messages: [
              ...item.messages,
              { message_id: `sent-${String(input.rank)}`, rank: input.rank, step: place.next_step ?? 'contact', step_label: input.rank === 0 ? 'Contact' : `R${String(input.rank)}`, status: 'sent' as const, sent_at: sentAt, sent_source: 'manual' as const, has_content: false },
            ],
          }
        : item,
    )
    placed(current, { place: next, sequences: updated })
    const message = { id: `sent-${String(input.rank)}`, rank: input.rank, step: place.next_step, status: 'sent', sent_at: sentAt }
    return reply(201, { message, created: true, changed: true, unvalidated: false })
  }

  function raiseAlert(input: { type: QualityAlert['type']; prospect_id: string; note: string | null }): Promise<Response> {
    const current = store.get(input.prospect_id)
    if (!current) return refusal(404, 'not_found')
    if (alerts.some((alert) => alert.open && alert.prospect_id === current.id && alert.type === input.type && alert.source === 'human')) {
      return refusal(409, 'alert_exists')
    }
    const created = qualityAlert({ prospect_id: current.id, type: input.type, note: input.note, raised_at: `${TODAY}T10:00:00+00:00` })
    alerts.unshift(created)
    if (input.type === 'email_error') {
      const before = placeOf(current)
      placed(current, { ...before, place: { ...before.place, email_error: true, next_due_on: null, pause_reason: 'email_error' } })
    }
    return reply(201, created)
  }

  function resolveAlert(id: string, note: string | null): Promise<Response> {
    const alert = alerts.find((item) => item.id === id)
    if (!alert) return refusal(404, 'not_found')
    if (!alert.open) return refusal(409, 'alert_resolved')
    Object.assign(alert, { open: false, resolved_at: `${TODAY}T11:00:00+00:00`, resolved_by: 'Opératrice Test', resolution_note: note })
    const current = alert.prospect_id ? store.get(alert.prospect_id) : undefined
    if (current && alert.type === 'email_error') {
      const before = placeOf(current)
      placed(current, { ...before, place: { ...before.place, email_error: false, pause_reason: null } })
    }
    return reply(200, alert)
  }

  function handleAlerts(method: string, url: URL, body: unknown): Promise<Response> {
    const [, , , id] = url.pathname.split('/')
    if (method === 'GET') {
      const prospectId = url.searchParams.get('prospect')
      const items = alerts.filter((alert) => !prospectId || alert.prospect_id === prospectId)
      return reply(200, { items, total: items.length, limit: 100, offset: 0 })
    }
    if (method === 'POST' && id) return resolveAlert(id, (body as { note: string | null }).note)
    return raiseAlert(body as { type: QualityAlert['type']; prospect_id: string; note: string | null })
  }

  function handle(method: string, url: URL, body: unknown): Promise<Response> {
    const [, , , id, action, sub] = url.pathname.split('/')
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
    if (method === 'GET' && action === 'sequences') return reply(200, { prospect_id: current.id, ...placeOf(current) })
    if (method === 'PUT' && action === 'cohort') return changeCohort(current, (body as { cohort_id: string | null }).cohort_id)
    if (method === 'POST' && action === 'messages' && sub === 'mark-sent') {
      return markSent(current, body as { rank: number; sequence_id?: string; sent_at?: string })
    }
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
      // The state only; the Contact rules themselves are tested in the backend.
      const patch = body as TrackingPatch
      if (current.tracking?.status === 'ignored') return refusal(409, 'ignored_is_terminal')
      const tracking = current.tracking ?? trackingDetail()
      const updated: Prospect & { cancelled_messages: number; in_flight_messages: number } = {
        ...current,
        version: `${current.version}+`,
        cancelled_messages: 0,
        in_flight_messages: 0,
        tracking: { ...tracking, status: patch.status },
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
    if (url.pathname.startsWith('/api/alerts')) {
      const method = init?.method ?? 'GET'
      const body: unknown = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined
      requests.push({ method, path: url.pathname, search: url.search, body })
      return handleAlerts(method, url, body)
    }
    if (url.pathname.startsWith('/api/companies')) return companies.fetchMock(input, init)
    return prospection.fetchMock(input, init)
  })
  vi.stubGlobal('fetch', fetchMock)
  return { store, requests, next, companies: companies.store, sequences, alerts, cohorts: prospection.settings.contact.cohorts }
}

// Body of the last `method` request to a prospect path.
export function lastBody(requests: RecordedRequest[], method: string): unknown {
  const request = requests.filter((item) => item.method === method).at(-1)
  if (!request) throw new Error(`No ${method} request was sent.`)
  return request.body
}
