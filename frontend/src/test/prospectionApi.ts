import { vi } from 'vitest'

import type { Company, CompanyListItem } from '../api/companies'
import type { ImportBatch } from '../api/imports'
import { type ProspectRow, SEGMENTS, type Segment } from '../api/prospection'
import type { Referent, TaxonomyValue } from '../api/settings'
import { matchesWords } from '../lib/text'
import { type RecordedRequest, stubSettingsApi } from './settingsApi'

// In-memory stand-in for /api/prospection (backend/app/api/routes/prospection.py) for component tests. The segment
// semantics live in the backend (tested there); here each synthetic row simply lists the segments it belongs to.
// Search matches the name, company and e-mail; the company and activity filters are applied. Synthetic values only.

export interface FakeProspect extends ProspectRow {
  segments: Segment[]
}

let sequence = 0

export function prospect(
  first_name: string,
  last_name: string,
  fields: Partial<ProspectRow> = {},
  segments: Segment[] = [],
): FakeProspect {
  sequence += 1
  return {
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
    primary_email: null,
    primary_email_status: null,
    email_state: 'missing',
    primary_phone: null,
    primary_phone_type: null,
    tracking_status: null,
    planned_contact_at: null,
    due: false,
    planned_contact_week: null,
    response_received_at: null,
    appointment_at: null,
    referent_id: null,
    referent_name: null,
    contactability_status: 'contactable',
    do_not_contact_at: null,
    updated_at: '2026-09-01T09:30:00+00:00',
    ...fields,
    segments,
  }
}

function asRow(fake: FakeProspect): ProspectRow {
  const row: Partial<FakeProspect> = { ...fake }
  delete row.segments
  return row as ProspectRow
}

function reply(status: number, body?: unknown): Promise<Response> {
  return Promise.resolve(
    new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } }),
  )
}

interface ProspectionStubOptions {
  prospects?: FakeProspect[]
  roles?: TaxonomyValue[]
  referents?: Referent[]
  companies?: Pick<Company, 'id' | 'display_name'>[]
  imports?: ImportBatch[]
  staleThresholdDays?: number | null
  // Answer every /api/prospection request with this status (error states).
  failWith?: number
}

export function stubProspectionApi(options: ProspectionStubOptions = {}) {
  const { prospects = [], roles = [], referents = [], companies = [], imports = [] } = options
  const settings = stubSettingsApi({ roles, referents })
  const requests: RecordedRequest[] = []

  function matching(params: URLSearchParams): FakeProspect[] {
    const q = params.get('q') ?? ''
    const company = params.get('company')
    const activity = params.get('activity')
    return prospects.filter(
      (row) =>
        (!q || matchesWords([row.first_name, row.last_name, row.company_name, row.primary_email].join(' '), q)) &&
        (!company || row.company_id === company) &&
        (!activity || row.activity_status === activity),
    )
  }

  function inSegment(row: FakeProspect, segment: Segment): boolean {
    return segment === 'all' || row.segments.includes(segment)
  }

  function handle(url: URL): Promise<Response> {
    if (options.failWith) return reply(options.failWith, { detail: 'boom' })
    const found = matching(url.searchParams)
    if (url.pathname === '/api/prospection/counters') {
      const counts = Object.fromEntries(
        SEGMENTS.map((segment) => [segment, found.filter((row) => inSegment(row, segment)).length]),
      )
      return reply(200, { counts, today: '2026-09-10', stale_threshold_days: options.staleThresholdDays ?? null })
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
    if (url.pathname === '/api/companies') {
      const items = companies.map((company) => ({ id: company.id, display_name: company.display_name }) as CompanyListItem)
      return reply(200, { items, total: items.length })
    }
    if (url.pathname === '/api/imports') return reply(200, imports)
    return settings.fetchMock(input, init)
  })
  vi.stubGlobal('fetch', fetchMock)
  return { requests, prospects, fetchMock }
}

// The query parameters of the last request to `path` (e.g. '/api/prospection/prospects').
export function lastParams(requests: RecordedRequest[], path: string): URLSearchParams {
  const request = requests.filter((item) => item.path === path).at(-1)
  return new URLSearchParams(request?.search ?? '')
}
