import { vi } from 'vitest'

import type { Company, CompanyListItem } from '../api/companies'
import type { ImportBatch } from '../api/imports'
import { type ProspectRow, REVIEWS, type Review, SEGMENTS, type Segment } from '../api/prospection'
import type { Cohort, Referent, TaxonomyValue } from '../api/settings'
import { matchesWords } from '../lib/text'
import { type RecordedRequest, stubSettingsApi } from './settingsApi'

// In-memory stand-in for /api/prospection (backend/app/api/routes/prospection.py) for component tests. The segment
// semantics live in the backend (tested there); here each synthetic row simply lists the segments it belongs to.
// Search matches the name, company and e-mail; the company and activity filters are applied. Synthetic values only.

export interface FakeProspect extends ProspectRow {
  segments: Segment[]
  // Counted in the « + cette semaine » figure of its panel.
  thisWeek: boolean
}

let sequence = 0

export function prospect(
  first_name: string,
  last_name: string,
  fields: Partial<ProspectRow> = {},
  segments: Segment[] = [],
  thisWeek = false,
): FakeProspect {
  sequence += 1
  const row: ProspectRow = {
    id: `00000000-0000-7000-b000-${String(sequence).padStart(12, '0')}`,
    civility: null,
    first_name,
    last_name,
    role_label: null,
    exact_job_title: null,
    company_id: null,
    company_name: null,
    activity_status: 'unknown',
    employment_verified_at: null,
    verification_state: 'never_verified',
    review: 'incomplete',
    primary_email: null,
    primary_email_status: null,
    email_state: 'missing',
    primary_phone: null,
    primary_phone_type: null,
    tracking_status: null,
    cohort_code: null,
    sent_count: 0,
    next_step: null,
    finished: false,
    level: null,
    level_label: null,
    next_due_at: null,
    next_due_week: null,
    due: false,
    email_error: false,
    response_received_at: null,
    appointment_at: null,
    referent_id: null,
    referent_name: null,
    contactability_status: 'contactable',
    do_not_contact_at: null,
    updated_at: '2026-09-01T09:30:00+00:00',
    ...fields,
  }
  // The backend decides the panel; the stand-in applies the same rule to the row's own fields.
  if (!fields.review) {
    if (row.tracking_status === 'ignored') row.review = 'ignored'
    else if (row.verification_state === 'verified' && row.email_state === 'verified') row.review = 'verified'
  }
  return { ...row, segments, thisWeek }
}

function asRow(fake: FakeProspect): ProspectRow {
  const row: Partial<FakeProspect> = { ...fake }
  delete row.segments
  delete row.thisWeek
  return row as ProspectRow
}

function reply(status: number, body?: unknown): Promise<Response> {
  return Promise.resolve(
    new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } }),
  )
}

interface ProspectionStubOptions {
  prospects?: FakeProspect[]
  warehouseContacts?: number
  roles?: TaxonomyValue[]
  referents?: Referent[]
  // Paramètres › Cohortes (S0 is always there).
  cohorts?: Cohort[]
  companies?: Pick<Company, 'id' | 'display_name'>[]
  imports?: ImportBatch[]
  staleThresholdDays?: number | null
  // Answer every /api/prospection request with this status (error states).
  failWith?: number
  isUncertain?: (id: string) => boolean
}

export function stubProspectionApi(options: ProspectionStubOptions = {}) {
  const { prospects = [], roles = [], referents = [], companies = [], imports = [] } = options
  const settings = stubSettingsApi({ roles, referents }, options.cohorts ? { cohorts: options.cohorts } : {})
  const requests: RecordedRequest[] = []

  function matching(params: URLSearchParams): FakeProspect[] {
    const q = params.get('q') ?? ''
    // A repeated parameter: any of its values (backend OR), no value: not filtered.
    const among = (key: string, value: string | null | undefined) => !params.getAll(key).length || params.getAll(key).includes(value ?? '')
    return prospects.filter(
      (row) =>
        (!params.has('verification_box') || (() => {
          const ignored = row.review === 'ignored'
          const validated = !ignored && row.employment_verified_at !== null
          const uncertain = !ignored && !validated && !!options.isUncertain?.(row.id)
          const box = ignored ? 'ignored' : validated ? 'validated' : uncertain ? 'uncertain' : 'todo'
          return among('verification_box', box)
        })()) &&
        (params.get('include_ignored') === 'true' || params.getAll('review').includes('ignored') || params.getAll('verification_box').includes('ignored') || row.review !== 'ignored') &&
        among('review', row.review) &&
        (params.get('validated_only') !== 'true' || (row.employment_verified_at !== null && row.review !== 'ignored')) &&
        (params.get('reachable') !== 'true' || (
          row.contactability_status === 'contactable' && row.activity_status !== 'inactive' &&
          !['ignored', 'disqualified', 'not_interested'].includes(row.tracking_status ?? '') &&
          ((!!row.primary_email && row.email_state !== 'invalid') || !!row.primary_phone)
        )) &&
        (!params.getAll('services').length || params.getAll('services').some((code) => row.proposed_services?.includes(code))) &&
        among('company_kind', row.company_kind ?? 'unclassified') &&
        among('send_stage', row.send_stage) &&
        (!q || matchesWords([row.first_name, row.last_name, row.company_name, row.primary_email].join(' '), q)) &&
        among('company', row.company_id) &&
        among('activity', row.activity_status),
    )
  }

  function inSegment(row: FakeProspect, segment: Segment): boolean {
    return segment === 'all' || row.segments.includes(segment)
  }

  function handle(url: URL): Promise<Response> {
    if (options.failWith) return reply(options.failWith, { detail: 'boom' })
    const found = matching(url.searchParams)
    if (url.pathname === '/api/prospection/dashboard') {
      const base = url.searchParams.get('validated_only') === 'true' ? prospects.filter((row) => row.employment_verified_at !== null && row.review !== 'ignored') : prospects
      const scored = base.flatMap((row) => row.quality_score == null ? [] : [row.quality_score])
      return reply(200, {
        total: base.length,
        reviews: Object.fromEntries(REVIEWS.map((key) => [key, url.searchParams.get('validated_only') === 'true' ? (key === 'verified' ? base.length : 0) : base.filter((row) => row.review === key).length])),
        sends: Object.fromEntries(['sent', 'r1', 'r2'].map((key) => [key, base.filter((row) => row.send_stage === key).length])),
        due: base.filter((row) => row.due).length,
        average_quality: scored.length ? scored.reduce((sum, value) => sum + value, 0) / scored.length : null,
        scored_count: scored.length,
      })
    }
    if (url.pathname === '/api/prospection/filter-options') {
      return reply(200, { companies: companies.map((company) => ({ id: company.id, label: company.display_name })), company_departments: [], warehouse_departments: [] })
    }
    if (url.pathname === '/api/prospection/overview') {
      const ignored = prospects.filter((row) => row.review === 'ignored').length
      const employment_validated = prospects.filter((row) => row.employment_verified_at !== null && row.review !== 'ignored').length
      const uncertain = prospects.filter((row) => row.review !== 'ignored' && row.employment_verified_at === null && options.isUncertain?.(row.id)).length
      return reply(200, { total: prospects.length, contacted: 0, deleted: 0, ignored, employment_validated, employment_pending: prospects.length - ignored - employment_validated, uncertain, todo: prospects.length - ignored - employment_validated - uncertain })
    }
    if (url.pathname === '/api/prospection/counters') {
      const counts = Object.fromEntries(
        SEGMENTS.map((segment) => [segment, found.filter((row) => inSegment(row, segment)).length]),
      )
      const reviews = Object.fromEntries(
        REVIEWS.map((review: Review) => {
          const members = found.filter((row) => row.review === review)
          return [review, { total: members.length, week: members.filter((row) => row.thisWeek).length }]
        }),
      )
      return reply(200, {
        counts,
        reviews,
        today: '2026-09-10',
        stale_threshold_days: options.staleThresholdDays ?? null,
      })
    }
    const segment = (url.searchParams.get('segment') ?? 'all') as Segment
    const limit = Number(url.searchParams.get('limit') ?? 50)
    const offset = Number(url.searchParams.get('offset') ?? 0)
    const rows = found.filter((row) => inSegment(row, segment))
    const items = rows.slice(offset, offset + limit).map(asRow)
    return reply(200, { items, total: rows.length, limit, offset })
  }

  const fetchMock = vi.fn((input: string, init?: RequestInit) => {
    const url = new URL(input, 'http://localhost')
    if (url.pathname.startsWith('/api/prospection/')) {
      requests.push({ method: init?.method ?? 'GET', path: url.pathname, search: url.search, body: undefined })
      return handle(url)
    }
    if (url.pathname === '/api/companies/counts') return reply(200, { all: companies.length, sme: 0, large: 0, institutional: 0, unclassified: companies.length })
    if (url.pathname === '/api/warehouses/counts') return reply(200, { warehouses: 0, contacts: options.warehouseContacts ?? 0, to_contact: 0 })
    if (url.pathname === '/api/warehouses') return reply(200, { items: [], total: 0 })
    if (url.pathname === '/api/companies') {
      const items = companies.map((company) => ({ id: company.id, display_name: company.display_name }) as CompanyListItem)
      return reply(200, { items, total: items.length })
    }
    if (url.pathname === '/api/imports') return reply(200, imports)
    return settings.fetchMock(input, init)
  })
  vi.stubGlobal('fetch', fetchMock)
  return { requests, prospects, fetchMock, settings }
}

// The query parameters of the last request to `path` (e.g. '/api/prospection/prospects').
export function lastParams(requests: RecordedRequest[], path: string): URLSearchParams {
  const request = requests.filter((item) => item.path === path).at(-1)
  return new URLSearchParams(request?.search ?? '')
}
