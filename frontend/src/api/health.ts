import { useQuery } from '@tanstack/react-query'

import { apiGet } from './client'

// Mirrors backend `HealthResponse` (backend/app/api/routes/health.py).
export interface Health {
  status: 'ok' | 'degraded'
  database: 'ok' | 'unavailable'
}

export function useHealth() {
  return useQuery({
    queryKey: ['health'],
    queryFn: ({ signal }) => apiGet<Health>('/health', signal),
  })
}
