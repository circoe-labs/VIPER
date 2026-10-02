import { vi } from 'vitest'

import type { Cohort, Referent, TaxonomyKind, TaxonomyValue } from '../api/settings'
import { foldText, matchesWords } from '../lib/text'

// In-memory stand-in for /api/settings (backend/app/api/routes/settings.py) for component tests: same refusals
// (duplicate label ignoring case/accents, in-use deletion) and the same `detail` shapes. Synthetic values only.

export interface RecordedRequest {
  method: string
  path: string
  search: string
  body: unknown
}

type Store = Record<TaxonomyKind, TaxonomyValue[]> & { referents: Referent[] }

// The cohorts (`S0` seeded like migration 0010) and « max relances » (4 by default).
interface ContactStore {
  cohorts: Cohort[]
  max_follow_ups: number
}

const STAMP = '2026-09-01T09:30:00+00:00'
let sequence = 0

export function taxonomyValue(label: string, fields: Partial<TaxonomyValue> = {}): TaxonomyValue {
  sequence += 1
  return {
    id: `00000000-0000-7000-8000-${String(sequence).padStart(12, '0')}`,
    label,
    slug: foldText(label).replace(/[^a-z0-9]+/g, '-'),
    active: true,
    usage_count: 0,
    created_at: STAMP,
    updated_at: STAMP,
    ...fields,
  }
}

export function referent(first_name: string, last_name: string, fields: Partial<Referent> = {}): Referent {
  sequence += 1
  return {
    id: `00000000-0000-7000-9000-${String(sequence).padStart(12, '0')}`,
    first_name,
    last_name,
    email: null,
    active: true,
    usage_count: 0,
    created_at: STAMP,
    updated_at: STAMP,
    ...fields,
  }
}

function reply(status: number, body?: unknown): Promise<Response> {
  if (status === 204) return Promise.resolve(new Response(null, { status }))
  return Promise.resolve(
    new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } }),
  )
}

export function cohort(code: string, starts_on: string | null, fields: Partial<Cohort> = {}): Cohort {
  sequence += 1
  return {
    id: `00000000-0000-7000-d000-${String(sequence).padStart(12, '0')}`,
    code,
    starts_on,
    out_of_campaign: code === 'S0',
    needs_review: false,
    current_count: 0,
    sequence_count: 0,
    ...fields,
  }
}

export const S0 = cohort('S0', null)

// `S37`, « s 037 » → `S37` (backend core/cohort_codes); null for anything else.
function cohortCode(raw: string): string | null {
  const match = /^(?:s|sem|semaine)\s*0*(\d{1,6})$/.exec(raw.trim().toLowerCase())
  return match ? `S${String(Number(match[1]))}` : null
}

function refused(status: number, detail: Record<string, unknown>): Promise<Response> {
  return reply(status, { detail: { message: 'Refused.', ...detail } })
}

const nameOf = (value: TaxonomyValue | Referent) =>
  'label' in value ? value.label : `${value.first_name} ${value.last_name}`

export function stubSettingsApi(initial: Partial<Store> = {}, contactInitial: Partial<ContactStore> = {}) {
  const contact: ContactStore = { cohorts: [S0], max_follow_ups: 4, ...structuredClone(contactInitial) }
  const store: Store = {
    roles: [],
    'activity-categories': [],
    'commercial-segments': [],
    referents: [],
    ...structuredClone(initial),
  }
  const requests: RecordedRequest[] = []
  // Set to make the next list call fail (error state).
  const failures = new Set<string>()

  function duplicate(existing: TaxonomyValue | Referent, field = 'label') {
    return reply(409, {
      detail: {
        code: 'duplicate',
        field,
        message: 'Another value already has this label.',
        existing: { id: existing.id, label: nameOf(existing), active: existing.active },
      },
    })
  }

  // Cohorts and « max relances » with the backend's refusals (app/services/cohorts.py, app_settings.py).
  function handleContact(method: string, url: URL, body: unknown): Promise<Response> {
    const payload = (body ?? {}) as { code?: string; starts_on?: string | null; max_follow_ups?: number }
    if (url.pathname === '/api/settings/contact') {
      if (method === 'PUT') contact.max_follow_ups = payload.max_follow_ups ?? contact.max_follow_ups
      return reply(200, { max_follow_ups: contact.max_follow_ups })
    }
    const id = url.pathname.split('/')[4]
    const target = contact.cohorts.find((value) => value.id === id)
    if (method === 'GET') return reply(200, contact.cohorts)
    if (id && !target) return refused(404, { code: 'not_found' })
    if ((method === 'PATCH' || method === 'DELETE') && target?.out_of_campaign) {
      return refused(409, { code: 'cohort_s0_fixed' })
    }
    if (method === 'DELETE' && target) {
      if (target.sequence_count > 0) return refused(409, { code: 'in_use', usage: { sequences: target.sequence_count } })
      contact.cohorts.splice(contact.cohorts.indexOf(target), 1)
      return reply(204)
    }
    const code = payload.code === undefined ? (target?.code ?? '') : cohortCode(payload.code)
    if (code === null) return refused(422, { code: 'invalid', field: 'code', reason: 'cohort_code' })
    const twin = contact.cohorts.find((value) => value.code === code && value.id !== id)
    if (twin) return refused(409, { code: 'duplicate', field: 'code', existing: { id: twin.id, label: twin.code, active: true } })
    const startsOn = payload.starts_on ?? target?.starts_on ?? null
    if (!startsOn) return refused(422, { code: 'invalid', field: 'starts_on', reason: 'required' })
    if (method === 'POST') {
      const created = cohort(code, startsOn)
      contact.cohorts.push(created)
      return reply(201, created)
    }
    if (method === 'PATCH' && target) {
      Object.assign(target, { code, starts_on: startsOn, needs_review: false })
      return reply(200, target)
    }
    return reply(405, { detail: 'Method Not Allowed' })
  }

  function handle(method: string, url: URL, body: unknown): Promise<Response> {
    if (url.pathname === '/api/health') return reply(200, { status: 'ok', database: 'ok' })
    if (/^\/api\/settings\/(cohorts|contact)(\/|$)/.test(url.pathname)) return handleContact(method, url, body)
    const match = /^\/api\/settings\/([a-z-]+)(?:\/([^/]+))?$/.exec(url.pathname)
    const resource = match?.[1] as keyof Store | undefined
    if (!match || !resource || !(resource in store)) return reply(404, { detail: 'Not Found' })
    const values: (TaxonomyValue | Referent)[] = store[resource]
    const id = match[2]
    const target = values.find((value) => value.id === id)
    const payload = (body ?? {}) as Record<string, unknown>

    if (method === 'GET') {
      if (failures.delete(resource)) return reply(500, { detail: 'boom' })
      const q = url.searchParams.get('q') ?? ''
      const active = url.searchParams.get('active')
      const searchable = (value: TaxonomyValue | Referent) =>
        'label' in value ? value.label : `${nameOf(value)} ${value.email ?? ''}`
      return reply(
        200,
        values.filter(
          (value) => (!q || matchesWords(searchable(value), q)) && (active === null || String(value.active) === active),
        ),
      )
    }
    if (id && !target) return reply(404, { detail: { code: 'not_found', message: 'Not found.' } })

    if (resource === 'referents') {
      if (method === 'POST' || method === 'PUT') {
        const input = payload as { first_name: string; last_name: string; email: string | null }
        const twin = store.referents.find(
          (value) => value.id !== id && foldText(nameOf(value)) === foldText(`${input.first_name} ${input.last_name}`),
        )
        if (twin) return duplicate(twin, 'name')
        const email = input.email?.toLowerCase() ?? null
        if (method === 'POST') {
          const created = referent(input.first_name.trim(), input.last_name.trim(), { email })
          store.referents.push(created)
          return reply(201, created)
        }
        Object.assign(target as Referent, { ...input, email })
        return reply(200, target)
      }
    } else if (method === 'POST') {
      const label = String(payload.label).trim().replace(/\s+/g, ' ')
      const twin = store[resource].find((value) => foldText(value.label) === foldText(label))
      if (twin) return duplicate(twin)
      const created = taxonomyValue(label)
      store[resource].push(created)
      return reply(201, created)
    } else if (method === 'PATCH' && typeof payload.label === 'string') {
      const label = payload.label.trim()
      const twin = store[resource].find((value) => value.id !== id && foldText(value.label) === foldText(label))
      if (twin) return duplicate(twin)
      Object.assign(target as TaxonomyValue, { label })
      return reply(200, target)
    }
    if (method === 'PATCH') {
      Object.assign(target as TaxonomyValue | Referent, { active: payload.active })
      return reply(200, target)
    }
    if (method === 'DELETE' && target) {
      if (target.usage_count > 0) {
        const noun = resource === 'roles' ? 'prospects' : resource === 'referents' ? 'contact_trackings' : 'companies'
        return reply(409, { detail: { code: 'in_use', message: 'Still referenced.', usage: { [noun]: target.usage_count } } })
      }
      values.splice(values.indexOf(target), 1)
      return reply(204)
    }
    return reply(405, { detail: 'Method Not Allowed' })
  }

  const fetchMock = vi.fn((input: string, init?: RequestInit) => {
    const url = new URL(input, 'http://localhost')
    const method = init?.method ?? 'GET'
    const body: unknown = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined
    requests.push({ method, path: url.pathname, search: url.search, body })
    return handle(method, url, body)
  })
  vi.stubGlobal('fetch', fetchMock)
  return { store, contact, requests, failures, fetchMock }
}
