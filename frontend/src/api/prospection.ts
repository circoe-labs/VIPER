import { keepPreviousData, type QueryClient, useQuery } from '@tanstack/react-query'

import { apiGet } from './client'
import type { SendSituation } from './unsent'

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
  'email_error',
] as const
export type Segment = (typeof SEGMENTS)[number]

// « Statut du prospect » (backend `Review`), exclusive and exhaustive, computed from the record: ignored (declined or
// do-not-contact) first, then verified (usable + well documented), usable (verified e-mail, name, company, role),
// incomplete (anything else, not to be contacted).
export const REVIEWS = ['verified', 'usable', 'incomplete', 'ignored'] as const
export type Review = (typeof REVIEWS)[number]

// The commercial states in display order (backend ContactTrackingStatus, sequences rework D7), each chosen by a person.
// `neutral` (« En séquence ») is the default: no badge. `ignored` is terminal; `disqualified` (« Défaillant ») is set
// by its own confirmed action. The level (Contact, R1…) is not a state: it is derived from the real sends.
export const TRACKING_STATUSES = [
  'neutral',
  'response_received',
  'appointment_obtained',
  'not_interested',
  'ignored',
  'disqualified',
] as const
export type TrackingStatus = (typeof TRACKING_STATUSES)[number]

// `next_due` = the derived next due date (backend ProspectSort; `planned_contact` is its former alias).
export const PROSPECT_SORTS = ['name', 'company', 'next_due', 'verification', 'updated', 'created', 'file'] as const
export type ProspectSort = (typeof PROSPECT_SORTS)[number]

export type ActivityStatus = 'active' | 'inactive' | 'unknown'
export type VerificationState = 'never_verified' | 'stale' | 'channels_reset' | 'verified'
export type EmailState = 'missing' | 'invalid' | 'unverified' | 'verified'
export type ChannelVerification = 'unverified' | 'verified' | 'invalid' | 'unknown'
// "No value" of the role, referent, tracking-status and cohort filters.
export const NONE = 'none'

export const VERIFICATION_BOXES = ['validated', 'uncertain', 'todo', 'ignored'] as const
export type VerificationBox = (typeof VERIFICATION_BOXES)[number]
export const SEND_STAGES = ['sent', 'r1', 'r2'] as const
export type SendStage = (typeof SEND_STAGES)[number]
export const EMAIL_STATES = ['verified', 'unverified', 'invalid', 'missing'] as const
export const COMPANY_KIND_FILTERS = ['sme', 'large', 'institutional', 'unclassified'] as const
export type CompanyKindFilter = (typeof COMPANY_KIND_FILTERS)[number]

// The criteria taking several values: any of one criterion's values (OR), the criteria combined with AND. Each is
// sent as a repeated parameter of its own name; an empty list does not filter.
export const PROSPECT_LIST_FILTERS = [
  'services',
  'role',
  'activity',
  'referent',
  'tracking_status',
  'cohort',
  'company',
  'import_batch',
  'send_stage',
  'email_state',
  'company_kind',
  'commercial_segment',
  'activity_category',
  'department',
  'verification_box',
] as const

// Criteria shared by the counters and the list (the segment only narrows the list).
export interface ProspectFilters {
  created_from?: string | null
  created_to?: string | null
  reachable?: boolean
  // The ignored (declined / do not contact) are hidden unless asked for.
  include_ignored?: boolean
  validated_only?: boolean
  verification_box: VerificationBox[]
  services: string[]
  send_stage: SendStage[]
  email_state: EmailState[]
  company_kind: CompanyKindFilter[]
  // `none` in role, referent, tracking_status, cohort, commercial_segment, activity_category: no value.
  commercial_segment: string[]
  activity_category: string[]
  // French department numbers of one of the company's sites.
  department: string[]
  q: string
  role: string[]
  activity: ActivityStatus[]
  referent: string[]
  tracking_status: (TrackingStatus | typeof NONE)[]
  // Current cohorts' ids; `none`: no cohort (not validated).
  cohort: string[]
  company: string[]
  import_batch: string[]
}

export interface ProspectListCriteria extends ProspectFilters {
  segment: Segment
  // Statuses wanted (any of them); none = every status but the ignored.
  review: Review[]
  sort: ProspectSort
}

export interface Counters {
  counts: Record<Segment, number>
  // Size of each panel, and how many arrived since Monday (verified, added, or set aside this week).
  reviews: Record<Review, { total: number; week: number }>
  // Business day "due" compares with (ISO date, Europe/Paris).
  today: string
  // VIPER_VERIFICATION_STALE_DAYS; null = no age-based re-check configured.
  stale_threshold_days: number | null
}

// The whole base, whatever the search: people held, contacted, and deleted since the start.
export interface Overview {
  total: number
  contacted: number
  deleted: number
  employment_validated: number
  employment_pending: number
  uncertain: number
  todo: number
  ignored: number
}

export interface ProspectRow {
  company_kind?: 'sme' | 'large' | 'institutional' | null
  proposed_services?: string[]
  quality_score?: number | null
  quality_band?: 'red' | 'yellow' | 'green' | null
  send_stage?: 'sent' | 'r1' | 'r2' | null
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
  review: Review
  primary_email: string | null
  primary_email_status: ChannelVerification | null
  email_state: EmailState
  primary_phone: string | null
  primary_phone_type: 'mobile' | 'landline' | 'other' | null
  tracking_status: TrackingStatus | null
  // The current cohort (`S39`, `S0`); null: not validated.
  cohort_code: string | null
  // Messages really sent in the current sequence; the step to send next (`contact`, `r2`…; null when finished or
  // without cohort); « Relance terminée ».
  sent_count: number
  next_step: string | null
  finished: boolean
  // The level key (`contact_pending`, `contact_sent`, `r2_sent`, `finished`): the UI words it itself (levelLabel).
  // The API's `level_label` is the lists' wording of the same key, kept for exports and other readers.
  level: string | null
  level_label: string | null
  // Derived next due date (business midnight) and its calendar week; null when nothing is due.
  next_due_at: string | null
  // The effective schedule, or why a scheduled mail did not leave.
  send?: SendSituation | null
  next_due_week: string | null
  // In the `due` segment (« Échus »): the Contact or a follow-up to send, due no later than today.
  due: boolean
  // An open « Erreur sur le mail » raised by a person or an import (out of the automatic actions).
  email_error: boolean
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
  overview: ['prospection', 'overview'] as const,
  filterOptions: ['prospection', 'filter-options'] as const,
  counters: (filters: ProspectFilters) => ['prospection', 'counters', filters] as const,
  page: (criteria: ProspectListCriteria, page: number) => ['prospection', 'page', criteria, page] as const,
}

function filterParams(filters: ProspectFilters): URLSearchParams {
  const params = new URLSearchParams()
  if (filters.reachable) params.set('reachable', 'true')
  if (filters.validated_only) params.set('validated_only', 'true')
  if (filters.include_ignored) params.set('include_ignored', 'true')
  const q = filters.q.trim()
  if (q) params.set('q', q)
  for (const key of PROSPECT_LIST_FILTERS) for (const value of filters[key]) params.append(key, value)
  for (const key of ['created_from', 'created_to'] as const) {
    const value = filters[key]
    if (value) params.set(key, value)
  }
  return params
}

export function filtersOf(criteria: Omit<ProspectListCriteria, 'sort'>): ProspectFilters {
  const { q, role, activity, referent, tracking_status, cohort, company, import_batch, services, send_stage, email_state, company_kind, commercial_segment, activity_category, department, reachable, include_ignored, validated_only, verification_box, created_from, created_to } = criteria
  return { q, role, activity, referent, tracking_status, cohort, company, import_batch, services, send_stage, email_state, company_kind, commercial_segment, activity_category, department, reachable, include_ignored, validated_only, verification_box, created_from, created_to }
}

// The filter panels' choices that only the data knows: every company, and the departments present.
export interface FilterOptions {
  companies: { id: string; label: string }[]
  company_departments: string[]
  warehouse_departments: string[]
}

export function useFilterOptions() {
  return useQuery({
    queryKey: prospectionKeys.filterOptions,
    queryFn: ({ signal }) => apiGet<FilterOptions>('/prospection/filter-options', signal),
  })
}

export function useProspectionCounters(filters: ProspectFilters) {
  return useQuery({
    queryKey: prospectionKeys.counters(filters),
    queryFn: ({ signal }) => apiGet<Counters>(`/prospection/counters?${filterParams(filters).toString()}`, signal),
    placeholderData: keepPreviousData,
  })
}

export function useProspectionOverview() {
  return useQuery({
    queryKey: prospectionKeys.overview,
    queryFn: ({ signal }) => apiGet<Overview>('/prospection/overview', signal),
  })
}

function pagePath(criteria: ProspectListCriteria, page: number): `/${string}` {
  const params = filterParams(criteria)
  params.set('segment', criteria.segment)
  for (const status of criteria.review) params.append('review', status)
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
