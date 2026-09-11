import { keepPreviousData, useQuery } from '@tanstack/react-query'

import { apiGet } from './client'

// Mirrors backend/app/api/routes/search.py: the global search of the shell (Task 17). Matching, ranking and limits:
// doc/features/global-search.md.

export const SEARCH_MIN_LENGTH = 2
export const SEARCH_MAX_LENGTH = 200

export type SearchType = 'prospect' | 'company' | 'establishment'
export type MatchField =
  | 'name'
  | 'legal_name'
  | 'email'
  | 'phone'
  | 'siren'
  | 'email_domain'
  | 'website'
  | 'siret'
  | 'city'
export type MatchKind = 'exact' | 'prefix' | 'contains'
export type SearchBadge = 'do_not_contact' | 'inactive' | 'primary'

interface HitBase {
  id: string
  label: string
  // Prospect: role · exact title; company: legal name when it differs; establishment: address.
  sublabel: string | null
  // The field that matched and how; `value` is the matched value when the label does not show it (e-mail, SIREN…).
  match: { field: MatchField; kind: MatchKind; value: string | null }
  badges: SearchBadge[]
  // The record editor that opens the result (an establishment opens its company).
  open: { editor: 'prospect' | 'company'; id: string }
  // The result's row in the Database Explorer.
  record: { table: 'prospects' | 'companies' | 'establishments'; id: string }
}

export interface ProspectHit extends HitBase {
  type: 'prospect'
  company_id: string | null
  company_name: string | null
}

export interface CompanyHit extends HitBase {
  type: 'company'
  siren: string | null
  email_domain: string | null
  // City of the primary establishment.
  city: string | null
  prospect_count: number
}

export interface EstablishmentHit extends HitBase {
  type: 'establishment'
  company_id: string
  company_name: string
  siret: string | null
}

export type SearchHit = ProspectHit | CompanyHit | EstablishmentHit

export interface SearchGroup {
  type: SearchType
  items: SearchHit[]
  // More matches than listed: the user can narrow the query.
  has_more: boolean
}

export interface SearchResults {
  // The query as searched (spaces collapsed).
  query: string
  // Non-empty groups, the one with the best first match first.
  groups: SearchGroup[]
}

// Spaces collapsed, as the backend reads the query.
export function normalizeQuery(text: string): string {
  return text.trim().replace(/\s+/g, ' ')
}

// Each query is its own cache entry: a new query cancels the previous request (its AbortSignal) and a late answer
// is never shown for another query. Meanwhile the previous results stay as placeholder (`isPlaceholderData`).
export function useSearch(query: string) {
  return useQuery({
    queryKey: ['search', query],
    queryFn: ({ signal }) => apiGet<SearchResults>(`/search?${new URLSearchParams({ q: query }).toString()}`, signal),
    enabled: query.length >= SEARCH_MIN_LENGTH,
    placeholderData: keepPreviousData,
  })
}
