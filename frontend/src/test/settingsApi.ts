import { vi } from 'vitest'

import type { Referent, TaxonomyKind, TaxonomyValue } from '../api/settings'
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

const nameOf = (value: TaxonomyValue | Referent) =>
  'label' in value ? value.label : `${value.first_name} ${value.last_name}`

export function stubSettingsApi(initial: Partial<Store> = {}) {
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

  function handle(method: string, url: URL, body: unknown): Promise<Response> {
    if (url.pathname === '/api/health') return reply(200, { status: 'ok', database: 'ok' })
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
  return { store, requests, failures, fetchMock }
}
