import { vi } from 'vitest'

import type { Company, CompanyInput, CompanyListItem, Establishment, SimilarCompany } from '../api/companies'
import type { HistoryEntry } from '../api/history'
import type { TaxonomyValue } from '../api/settings'
import { foldText, matchesWords } from '../lib/text'
import { historyPage } from './historyApi'
import { type RecordedRequest, stubSettingsApi } from './settingsApi'

// In-memory stand-in for /api/companies (backend/app/api/routes/companies.py) for component tests, on top of the
// Settings fake (pickers). Same `detail` shapes for refusals (duplicate SIREN, in-use deletion). Synthetic values only.

const STAMP = '2026-09-01T09:30:00+00:00'
let sequence = 0

function nextId(kind: string): string {
  sequence += 1
  return `00000000-0000-7000-${kind}-${String(sequence).padStart(12, '0')}`
}

export function company(display_name: string, fields: Partial<Company> = {}): Company {
  return {
    id: nextId('a000'),
    display_name,
    legal_name: null,
    siren: null,
    website_url: null,
    email_domain: null,
    size_label: null,
    commercial_segment: null,
    activity_categories: [],
    project_done_with_circoe: null,
    project_type: null,
    circoe_references: null,
    client_approach: null,
    establishments: [],
    prospect_count: 0,
    prospects: [],
    created_at: STAMP,
    updated_at: STAMP,
    ...fields,
  }
}

export function establishment(name: string, fields: Partial<Establishment> = {}): Establishment {
  return {
    id: nextId('e000'),
    name,
    siret: null,
    address_line1: null,
    address_line2: null,
    postal_code: null,
    city: null,
    country: null,
    kind: null,
    is_primary: false,
    ...fields,
  }
}

function reply(status: number, body?: unknown): Promise<Response> {
  if (status === 204) return Promise.resolve(new Response(null, { status }))
  const headers = { 'Content-Type': 'application/json' }
  return Promise.resolve(new Response(JSON.stringify(body), { status, headers }))
}

function listItem(row: Company): CompanyListItem {
  return {
    id: row.id,
    display_name: row.display_name,
    legal_name: row.legal_name,
    siren: row.siren,
    email_domain: row.email_domain,
    commercial_segment_label: row.commercial_segment?.label ?? null,
    city: row.establishments.find((establishment) => establishment.is_primary)?.city ?? null,
    establishment_count: row.establishments.length,
    prospect_count: row.prospect_count,
    updated_at: row.updated_at,
  }
}

interface CompaniesStubOptions {
  companies?: Company[]
  segments?: TaxonomyValue[]
  categories?: TaxonomyValue[]
  // Answer of GET /api/companies/similar.
  similar?: SimilarCompany[]
  // History entries per company id, newest first (none by default).
  histories?: Record<string, HistoryEntry[]>
}

export function stubCompaniesApi(options: CompaniesStubOptions = {}) {
  const { companies = [], segments = [], categories = [], similar = [], histories = {} } = options
  const settings = stubSettingsApi({ 'commercial-segments': segments, 'activity-categories': categories })
  const store = structuredClone(companies)
  const requests: RecordedRequest[] = []
  // Replaces the answer of the next company write (e.g. a 409 the fake would not produce).
  const next: { reply: [number, unknown] | null } = { reply: null }

  function saved(input: CompanyInput, previous: Company | null): Company {
    const refs = (values: TaxonomyValue[], ids: string[]) =>
      values.filter((value) => ids.includes(value.id)).map(({ id, label, active }) => ({ id, label, active }))
    const establishments = input.establishments.map((row) => ({ ...row, id: row.id ?? nextId('e000') }))
    const first = establishments[0]
    if (first && !establishments.some((row) => row.is_primary)) first.is_primary = true
    establishments.sort((a, b) => Number(b.is_primary) - Number(a.is_primary))
    const { commercial_segment_id, activity_category_ids, ...fields } = input
    return {
      ...(previous ?? company(input.display_name)),
      ...fields,
      commercial_segment:
        refs(settings.store['commercial-segments'], commercial_segment_id ? [commercial_segment_id] : [])[0] ?? null,
      activity_categories: refs(settings.store['activity-categories'], activity_category_ids),
      establishments,
      updated_at: '2026-09-02T10:00:00+00:00',
    }
  }

  function handle(method: string, url: URL, body: unknown): Promise<Response> {
    const id = /^\/api\/companies\/([^/]+)$/.exec(url.pathname)?.[1]
    if (url.pathname === '/api/companies/similar') return reply(200, similar)
    const historyOf = /^\/api\/companies\/([^/]+)\/history$/.exec(url.pathname)?.[1]
    if (historyOf) return reply(200, historyPage(histories[historyOf] ?? [], url))
    if (method !== 'GET' && next.reply) {
      const [status, detail] = next.reply
      next.reply = null
      return reply(status, detail)
    }
    if (url.pathname === '/api/companies') {
      if (method === 'POST') {
        const input = body as CompanyInput
        const twin = store.find((row) => input.siren && row.siren === input.siren)
        if (twin) {
          const existing = { id: twin.id, label: twin.display_name, active: true }
          return reply(409, { detail: { code: 'duplicate', field: 'siren', message: 'Duplicate.', existing } })
        }
        const created = saved(input, null)
        store.push(created)
        return reply(201, created)
      }
      const q = url.searchParams.get('q') ?? ''
      const offset = Number(url.searchParams.get('offset') ?? 0)
      const limit = Number(url.searchParams.get('limit') ?? 50)
      const text = (row: Company) =>
        [row.display_name, row.legal_name, row.email_domain, row.siren].filter(Boolean).join(' ')
      const found = store
        .filter((row) => !q || matchesWords(text(row), q))
        .sort((a, b) => foldText(a.display_name).localeCompare(foldText(b.display_name), 'fr'))
      return reply(200, { items: found.slice(offset, offset + limit).map(listItem), total: found.length })
    }
    const target = store.find((row) => row.id === id)
    if (!target) return reply(404, { detail: { code: 'not_found', message: 'Not found.' } })
    if (method === 'GET') return reply(200, target)
    if (method === 'PUT') {
      const updated = saved(body as CompanyInput, target)
      store.splice(store.indexOf(target), 1, updated)
      return reply(200, updated)
    }
    if (method === 'DELETE') {
      if (target.prospect_count > 0) {
        const usage = { prospects: target.prospect_count }
        return reply(409, { detail: { code: 'in_use', message: 'Still referenced.', usage } })
      }
      store.splice(store.indexOf(target), 1)
      return reply(204)
    }
    return reply(405, { detail: 'Method Not Allowed' })
  }

  const fetchMock = vi.fn((input: string, init?: RequestInit) => {
    const url = new URL(input, 'http://localhost')
    if (!url.pathname.startsWith('/api/companies')) return settings.fetchMock(input, init)
    const method = init?.method ?? 'GET'
    const body: unknown = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined
    requests.push({ method, path: url.pathname, search: url.search, body })
    return handle(method, url, body)
  })
  vi.stubGlobal('fetch', fetchMock)
  return { store, requests, next, settings, fetchMock }
}
