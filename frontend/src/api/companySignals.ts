import { useQuery } from '@tanstack/react-query'

import { apiGet } from './client'

// Mirrors GET /api/companies/{id}/signals: the signals stored for the company and its people.
export interface CompanySignal {
  id: string
  kind: string | null
  signal: string
  source_url: string | null
  observed_on: string | null
  valid_until: string | null
  relevance: number | null
  score_delta: number | null
  origin: 'manual' | 'agent'
  subject: string
}

export function useCompanySignals(companyId: string | undefined) {
  return useQuery({
    queryKey: ['companies', 'signals', companyId ?? ''],
    queryFn: ({ signal }) =>
      apiGet<CompanySignal[]>(`/companies/${encodeURIComponent(companyId ?? '')}/signals`, signal),
    enabled: Boolean(companyId),
    refetchOnWindowFocus: false,
  })
}
