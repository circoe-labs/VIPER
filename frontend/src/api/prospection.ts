import { keepPreviousData, type QueryClient, useQuery } from '@tanstack/react-query'

import { apiGet } from './client'

// Mirrors backend/app/api/routes/prospection.py: the Prospection counters and people list (Task 14). Segment
// definitions: backend/app/services/prospection/segments.py, doc/features/prospection-kpis.md.

export const SEGMENTS = [
  'all',
  'never_verified',
  'needs_recheck',
  'active',
  'unknown',
  'inactive',
  'do_not_contact',
  'email_missing',
  'email_invalid',
  'email_unverified',
  'to_contact',
  'due',
  'contacted',
  'no_response',
  'responses',
  'appointments',
] as const
export type Segment = (typeof SEGMENTS)[number]

export const TRACKING_STATUSES = [
  'to_contact',
  'contacted',
  'follow_up_1',
  'follow_up_2',
  'response_received',
  'appointment_obtained',
  'quote_sent',
  'quote_follow_up',
  'won',
  'not_interested',
] as const
export type TrackingStatus = (typeof TRACKING_STATUSES)[number]

export const PROSPECT_SORTS = ['name', 'company', 'planned_contact', 'verification', 'updated'] as const
export type ProspectSort = (typeof PROSPECT_SORTS)[number]

export type ActivityStatus = 'active' | 'inactive' | 'unknown'
export type VerificationState = 'never_verified' | 'stale' | 'channels_reset' | 'verified'
export type EmailState = 'missing' | 'invalid' | 'unverified' | 'verified'
export type ChannelVerification = 'unverified' | 'verified' | 'invalid' | 'unknown'
// "No value" of the role, referent and tracking-status filters.
export const NONE = 'none'

// Criteria shared by the counters and the list (the segment only narrows the list).
export interface ProspectFilters {
  q: string
  role: string | null
  activity: ActivityStatus | null
  referent: string | null
  tracking_status: TrackingStatus | typeof NONE | null
  company: string | null
  import_batch: string | null
}

export interface ProspectListCriteria extends ProspectFilters {
  segment: Segment
  sort: ProspectSort
}

export interface Counters {
  counts: Record<Segment, number>
  // Business day "due" compares with (ISO date, Europe/Paris).
  today: string
  // VIPER_VERIFICATION_STALE_DAYS; null = no age-based re-check configured.
  stale_threshold_days: number | null
}

export interface ProspectRow {
  id: string
  civility: 'mr' | 'ms' | null
  first_name: string | null
  last_name: string | null
  role_label: string | null
  exact_job_title: string | null
  company_id: string | null
  company_name: string | null
  activity_status: ActivityStatus
  employment_verified_at: string | null
  verification_state: VerificationState
  primary_email: string | null
  primary_email_status: ChannelVerification | null
  email_state: EmailState
  primary_phone: string | null
  primary_phone_type: 'mobile' | 'landline' | 'other' | null
  tracking_status: TrackingStatus | null
  planned_contact_at: string | null
  // In the `due` segment (to contact, planned no later than today) — computed by the backend's segment predicate.
  due: boolean
  // ISO week in business time, e.g. `2026-W38`.
  planned_contact_week: string | null
  response_received_at: string | null
  appointment_at: string | null
  referent_id: string | null
  referent_name: string | null
  contactability_status: 'contactable' | 'do_not_contact'
  do_not_contact_at: string | null
  updated_at: string
}

export interface ProspectPage {
  items: ProspectRow[]
  total: number
  limit: number
  offset: number
}

export const PROSPECT_PAGE_SIZE = 50

export const prospectionKeys = {
  // Invalidate this after any prospect write (Task 15): counters and every list page refresh.
  all: ['prospection'] as const,
  counters: (filters: ProspectFilters) => ['prospection', 'counters', filters] as const,
  page: (criteria: ProspectListCriteria, page: number) => ['prospection', 'page', criteria, page] as const,
}

function filterParams(filters: ProspectFilters): URLSearchParams {
  const params = new URLSearchParams()
  const q = filters.q.trim()
  if (q) params.set('q', q)
  for (const key of ['role', 'activity', 'referent', 'tracking_status', 'company', 'import_batch'] as const) {
    const value = filters[key]
    if (value) params.set(key, value)
  }
  return params
}

export function filtersOf(criteria: ProspectListCriteria): ProspectFilters {
  const { q, role, activity, referent, tracking_status, company, import_batch } = criteria
  return { q, role, activity, referent, tracking_status, company, import_batch }
}

export function useProspectionCounters(filters: ProspectFilters) {
  return useQuery({
    queryKey: prospectionKeys.counters(filters),
    queryFn: ({ signal }) => apiGet<Counters>(`/prospection/counters?${filterParams(filters).toString()}`, signal),
    placeholderData: keepPreviousData,
  })
}

function pagePath(criteria: ProspectListCriteria, page: number): `/${string}` {
  const params = filterParams(criteria)
  params.set('segment', criteria.segment)
  params.set('sort', criteria.sort)
  params.set('limit', String(PROSPECT_PAGE_SIZE))
  params.set('offset', String((page - 1) * PROSPECT_PAGE_SIZE))
  return `/prospection/prospects?${params.toString()}`
}

// `page` is 1-based, like the `page` URL parameter.
export function useProspectPage(criteria: ProspectListCriteria, page: number) {
  return useQuery({
    queryKey: prospectionKeys.page(criteria, page),
    queryFn: ({ signal }) => apiGet<ProspectPage>(pagePath(criteria, page), signal),
    placeholderData: keepPreviousData,
  })
}

// A page fetched fresh (not from the cache) — the prospect queue reads the current order after a save.
export function fetchProspectPage(queryClient: QueryClient, criteria: ProspectListCriteria, page: number) {
  return queryClient.query({
    queryKey: prospectionKeys.page(criteria, page),
    queryFn: ({ signal }) => apiGet<ProspectPage>(pagePath(criteria, page), signal),
    staleTime: 0,
  })
}
