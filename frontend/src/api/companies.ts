import { keepPreviousData, type QueryKey, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'

import { apiGet, apiRequest } from './client'
import { historyKeys } from './history'
import { refreshAfterWrite } from './refresh'

// Mirrors backend/app/api/routes/companies.py: the lightweight Company editor and its list (Task 07).

export interface TaxonomyRef {
  id: string
  label: string
  active: boolean
}

export interface Establishment {
  id: string
  name: string | null
  siret: string | null
  address_line1: string | null
  address_line2: string | null
  postal_code: string | null
  city: string | null
  country: string | null
  // Free text: siège, agence, entrepôt…
  kind: string | null
  is_primary: boolean
}

export type ActivityStatus = 'active' | 'inactive' | 'unknown'

export interface ProspectSummary {
  id: string
  civility: 'mr' | 'ms' | null
  first_name: string | null
  last_name: string | null
  role_label: string | null
  exact_job_title: string | null
  activity_status: ActivityStatus
  contactability_status: 'contactable' | 'do_not_contact'
}

export interface Company {
  id: string
  display_name: string
  legal_name: string | null
  siren: string | null
  website_url: string | null
  email_domain: string | null
  size_label: string | null
  commercial_segment: TaxonomyRef | null
  activity_categories: TaxonomyRef[]
  project_done_with_circoe: string | null
  project_type: string | null
  circoe_references: string | null
  client_approach: string | null
  // Primary first.
  establishments: Establishment[]
  prospect_count: number
  // The first 100, by last then first name.
  prospects: ProspectSummary[]
  created_at: string
  updated_at: string
}

export type EstablishmentInput = Omit<Establishment, 'id'> & { id: string | null }

// POST creates; PUT replaces every field, the categories and the full establishment list (one left out is removed).
export interface CompanyInput {
  display_name: string
  legal_name: string | null
  siren: string | null
  website_url: string | null
  email_domain: string | null
  size_label: string | null
  commercial_segment_id: string | null
  activity_category_ids: string[]
  project_done_with_circoe: string | null
  project_type: string | null
  circoe_references: string | null
  client_approach: string | null
  establishments: EstablishmentInput[]
}

export interface CompanyListItem {
  id: string
  display_name: string
  legal_name: string | null
  siren: string | null
  email_domain: string | null
  commercial_segment_label: string | null
  // City of the primary establishment.
  city: string | null
  establishment_count: number
  prospect_count: number
  updated_at: string
}

export interface CompanyPage {
  items: CompanyListItem[]
  total: number
}

export type SimilarityReason = 'same_company_name' | 'similar_company_name' | 'same_email_domain'

export interface SimilarCompany {
  id: string
  display_name: string
  legal_name: string | null
  email_domain: string | null
  reasons: SimilarityReason[]
}

export const COMPANY_PAGE_SIZE = 50

export const companyKeys = {
  all: ['companies'] as const,
  list: (search: string, offset: number, limit: number) => ['companies', 'list', search, offset, limit] as const,
  detail: (id: string) => ['companies', 'detail', id] as const,
  similar: (name: string, domain: string, exclude: string | null) => ['companies', 'similar', name, domain, exclude] as const,
}

function companyPath(id: string): `/${string}` {
  return `/companies/${encodeURIComponent(id)}`
}

// `limit` up to 200 (the API's maximum), e.g. for a company picker.
export function useCompanies(search: string, offset = 0, limit = COMPANY_PAGE_SIZE) {
  return useQuery({
    queryKey: companyKeys.list(search, offset, limit),
    queryFn: ({ signal }) => {
      const params = new URLSearchParams({ limit: String(limit), offset: String(offset) })
      if (search) params.set('q', search)
      return apiGet<CompanyPage>(`/companies?${params.toString()}`, signal)
    },
    placeholderData: keepPreviousData,
  })
}

export function useCompany(id: string | null) {
  return useQuery({
    queryKey: companyKeys.detail(id ?? ''),
    queryFn: ({ signal }) => apiGet<Company>(companyPath(id ?? ''), signal),
    enabled: id !== null,
  })
}

// Existing companies the one being typed may duplicate ("does it already exist?"), from its name and e-mail domain.
export function useSimilarCompanies(name: string, emailDomain: string, exclude: string | null) {
  return useQuery({
    queryKey: companyKeys.similar(name, emailDomain, exclude),
    queryFn: ({ signal }) => {
      const params = new URLSearchParams({ name, email_domain: emailDomain })
      if (exclude) params.set('exclude', exclude)
      return apiGet<SimilarCompany[]>(`/companies/similar?${params.toString()}`, signal)
    },
    enabled: name.trim().length >= 3 || emailDomain.trim() !== '',
    placeholderData: keepPreviousData,
  })
}

// Every write goes through the audited API; the list, the detail and its history refresh afterwards. Segment/category
// counts in Paramètres change too, so their caches are refreshed as well.
export function useCompanyMutations() {
  const queryClient = useQueryClient()
  const refresh = (...keys: QueryKey[]) => refreshAfterWrite(queryClient, [companyKeys.all, ['settings'], ...keys])
  const saved = (company: Company) => {
    queryClient.setQueryData(companyKeys.detail(company.id), company)
    void refresh(historyKeys.subject('companies', company.id))
  }
  return {
    create: useMutation({
      mutationFn: (input: CompanyInput) => apiRequest<Company>('POST', '/companies', { body: input }),
      onSuccess: saved,
    }),
    update: useMutation({
      mutationFn: ({ id, input }: { id: string; input: CompanyInput }) =>
        apiRequest<Company>('PUT', companyPath(id), { body: input }),
      onSuccess: saved,
    }),
    remove: useMutation({
      mutationFn: (id: string) => apiRequest<undefined>('DELETE', companyPath(id)),
      onSuccess: (_, id) => {
        queryClient.removeQueries({ queryKey: companyKeys.detail(id) })
        void refresh()
      },
    }),
  }
}
