import { keepPreviousData, type QueryClient, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'

import { foldText } from '../lib/text'
import { ApiError, apiGet, apiRequest } from './client'
import { refreshAfterWrite } from './refresh'

// Mirrors backend/app/api/routes/settings.py: administrable taxonomies and Circoe internal referents (Task 06), the
// cohorts `Sxx` and « max relances » (sequences rework D2, D5).

export type TaxonomyKind = 'roles' | 'activity-categories' | 'commercial-segments'

export interface TaxonomyValue {
  id: string
  label: string
  // Stable machine key: kept when the value is renamed.
  slug: string
  active: boolean
  // Prospects (roles) or companies (segments, categories) referencing the value.
  usage_count: number
  created_at: string
  updated_at: string
}

// A Circoe person named on contact tracking — not a login account.
export interface Referent {
  id: string
  first_name: string
  last_name: string
  email: string | null
  active: boolean
  // Contact trackings naming the referent.
  usage_count: number
  created_at: string
  updated_at: string
}

// A prospecting session `Sxx` and its real start date (never an ISO week); `S0`: validated, out of campaign, fixed.
export interface Cohort {
  id: string
  code: string
  starts_on: string | null
  out_of_campaign: boolean
  // Created by the migration from a former week: its date is to be confirmed by a person.
  needs_review: boolean
  // Prospects whose current sequence is in the cohort, and every sequence ever in it (deletable when 0).
  current_count: number
  sequence_count: number
}

export interface ContactSettings {
  // After R<max> is sent, the prospect is « Relance terminée » (0 … 20, 4 by default).
  max_follow_ups: number
}

export const MAX_FOLLOW_UPS_LIMIT = 20

export interface ReferentInput {
  first_name: string
  last_name: string
  email: string | null
}

export type ActiveFilter = 'all' | 'active' | 'inactive'

export interface ListFilters {
  search: string
  active: ActiveFilter
}

// The unfiltered list: shared by the Settings page (empty search) and every picker.
export const ALL_VALUES: ListFilters = { search: '', active: 'all' }

// Business refusal from the API (`detail` of a 404/409/422, backend/app/api/errors.py — shared by the Settings,
// Companies and Prospects APIs), turned into French copy by `settings/messages.ts`, `companies/messages.ts` and
// `prospects/messages.ts`. `conflict` (stale version) and `do_not_contact` come from the Prospects API only.
export interface SettingsRefusal {
  // Codes of backend/app/api/errors.py; the last three are the Contact tracking rules (prospects only).
  code:
    | 'cohort_s0_fixed'
    | 'duplicate'
    | 'in_use'
    | 'invalid'
    | 'not_found'
    | 'conflict'
    | 'do_not_contact'
    | 'ignored_is_terminal'
    | 'human_actor_required'
  field?: string
  // Why an `invalid` field was refused when it can fail in several ways (`format`, `checksum`, `webmail`…).
  reason?: string
  existing?: { id: string; label: string; active: boolean } | null
  // e.g. `{ prospects: 3 }`, `{ companies: 1 }`, `{ contact_trackings: 2 }`.
  usage?: Record<string, number>
}

export function settingsRefusal(error: unknown): SettingsRefusal | null {
  if (!(error instanceof ApiError)) return null
  const { detail } = error
  return typeof detail === 'object' && detail !== null && 'code' in detail ? (detail as SettingsRefusal) : null
}

export const settingsKeys = {
  all: ['settings'] as const,
  cohorts: ['settings', 'cohorts'] as const,
  contact: ['settings', 'contact'] as const,
  list: (resource: TaxonomyKind | 'referents') => ['settings', resource] as const,
  filtered: (resource: TaxonomyKind | 'referents', filters: ListFilters) => ['settings', resource, filters] as const,
}

function listPath(resource: TaxonomyKind | 'referents', { search, active }: ListFilters): `/${string}` {
  const params = new URLSearchParams()
  if (search.trim()) params.set('q', search.trim())
  if (active !== 'all') params.set('active', String(active === 'active'))
  const query = params.toString()
  return `/settings/${resource}${query ? `?${query}` : ''}`
}

export function useTaxonomyValues(kind: TaxonomyKind, filters: ListFilters = ALL_VALUES) {
  return useQuery({
    queryKey: settingsKeys.filtered(kind, filters),
    queryFn: ({ signal }) => apiGet<TaxonomyValue[]>(listPath(kind, filters), signal),
    // Keep the list on screen while a new search loads.
    placeholderData: keepPreviousData,
  })
}

export function useReferents(filters: ListFilters = ALL_VALUES) {
  return useQuery({
    queryKey: settingsKeys.filtered('referents', filters),
    queryFn: ({ signal }) => apiGet<Referent[]>(listPath('referents', filters), signal),
    placeholderData: keepPreviousData,
  })
}

// A value created inline must be selectable at once: add it to the cached unfiltered list before the refetch.
function addToAllValues<T extends { id: string }>(
  queryClient: QueryClient,
  resource: TaxonomyKind | 'referents',
  created: T,
  sortKey: (value: T) => string,
) {
  queryClient.setQueryData<T[]>(settingsKeys.filtered(resource, ALL_VALUES), (values) =>
    values
      ? [...values.filter((value) => value.id !== created.id), created].sort((a, b) =>
          foldText(sortKey(a)).localeCompare(foldText(sortKey(b)), 'fr'),
        )
      : values,
  )
}

// Every mutation goes through the audited API; lists (Settings and pickers) refresh afterwards. No optimistic update:
// the server decides on duplicates and usage.
export function useTaxonomyMutations(kind: TaxonomyKind) {
  const queryClient = useQueryClient()
  const refresh = () => refreshAfterWrite(queryClient, [settingsKeys.list(kind)])
  const valuePath = (id: string): `/${string}` => `/settings/${kind}/${encodeURIComponent(id)}`
  return {
    create: useMutation({
      mutationFn: (label: string) => apiRequest<TaxonomyValue>('POST', `/settings/${kind}`, { body: { label } }),
      onSuccess: (created) => {
        addToAllValues(queryClient, kind, created, (value) => value.label)
      },
      // Also after a refusal: a duplicate created elsewhere meanwhile then shows up in the pickers.
      onSettled: refresh,
    }),
    rename: useMutation({
      mutationFn: ({ id, label }: { id: string; label: string }) =>
        apiRequest<TaxonomyValue>('PATCH', valuePath(id), { body: { label } }),
      onSuccess: refresh,
    }),
    setActive: useMutation({
      mutationFn: ({ id, active }: { id: string; active: boolean }) =>
        apiRequest<TaxonomyValue>('PATCH', valuePath(id), { body: { active } }),
      onSuccess: refresh,
    }),
    remove: useMutation({
      mutationFn: (id: string) => apiRequest<undefined>('DELETE', valuePath(id)),
      onSuccess: refresh,
    }),
  }
}

export function referentName(referent: Pick<Referent, 'first_name' | 'last_name'>): string {
  return `${referent.first_name} ${referent.last_name}`
}

export function useReferentMutations() {
  const queryClient = useQueryClient()
  const refresh = () => refreshAfterWrite(queryClient, [settingsKeys.list('referents')])
  const referentPath = (id: string): `/${string}` => `/settings/referents/${encodeURIComponent(id)}`
  return {
    create: useMutation({
      mutationFn: (input: ReferentInput) => apiRequest<Referent>('POST', '/settings/referents', { body: input }),
      onSuccess: (created) => {
        addToAllValues(queryClient, 'referents', created, (value) => `${value.last_name} ${value.first_name}`)
      },
      onSettled: refresh,
    }),
    update: useMutation({
      mutationFn: ({ id, input }: { id: string; input: ReferentInput }) =>
        apiRequest<Referent>('PUT', referentPath(id), { body: input }),
      onSuccess: refresh,
    }),
    setActive: useMutation({
      mutationFn: ({ id, active }: { id: string; active: boolean }) =>
        apiRequest<Referent>('PATCH', referentPath(id), { body: { active } }),
      onSuccess: refresh,
    }),
    remove: useMutation({
      mutationFn: (id: string) => apiRequest<undefined>('DELETE', referentPath(id)),
      onSuccess: refresh,
    }),
  }
}

// S0 first, then by start date and code (backend order).
export function useCohorts() {
  return useQuery({
    queryKey: settingsKeys.cohorts,
    queryFn: ({ signal }) => apiGet<Cohort[]>('/settings/cohorts', signal),
  })
}

export function useContactSettings() {
  return useQuery({
    queryKey: settingsKeys.contact,
    queryFn: ({ signal }) => apiGet<ContactSettings>('/settings/contact', signal),
  })
}

// Cohort writes refresh the cohort list (and the pickers reading it); a re-dated cohort moves every due date it holds,
// so the planning readers (Prospection, Contact, Home, the open prospects' sequences) are read again.
export function useCohortMutations() {
  const queryClient = useQueryClient()
  const refresh = () =>
    refreshAfterWrite(queryClient, [settingsKeys.cohorts, ['prospection'], ['contact'], ['home'], ['sequences']])
  const cohortPath = (id: string): `/${string}` => `/settings/cohorts/${encodeURIComponent(id)}`
  return {
    create: useMutation({
      mutationFn: (input: { code: string; starts_on: string }) =>
        apiRequest<Cohort>('POST', '/settings/cohorts', { body: input }),
      onSettled: refresh,
    }),
    update: useMutation({
      mutationFn: ({ id, ...input }: { id: string; code?: string; starts_on?: string }) =>
        apiRequest<Cohort>('PATCH', cohortPath(id), { body: input }),
      onSuccess: refresh,
    }),
    remove: useMutation({
      mutationFn: (id: string) => apiRequest<undefined>('DELETE', cohortPath(id)),
      onSuccess: refresh,
    }),
  }
}

export function useContactSettingsMutation() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (input: ContactSettings) => apiRequest<ContactSettings>('PUT', '/settings/contact', { body: input }),
    onSuccess: (saved) => {
      queryClient.setQueryData(settingsKeys.contact, saved)
      // The maximum decides « Relance terminée » and the ranks offered everywhere.
      void refreshAfterWrite(queryClient, [settingsKeys.contact, ['prospection'], ['contact'], ['home'], ['sequences']])
    },
  })
}
