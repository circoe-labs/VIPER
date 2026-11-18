import { useQuery } from '@tanstack/react-query'

import { apiGet } from './client'
import { linkKeys, type Person } from './links'

// Mirrors backend/app/api/routes/links.py (`GET /links/proximity/prospect/{id}`): the proximity score 0-100 of a
// prospect from the members of the organisation, derived only from person links (doc/features/proximity-score.md).
// It is distinct from, and never feeds, the commercial-fit ProspectScore.

export type ProximityState = 'reachable' | 'unreachable' | 'empty'

export interface ProximityEdge {
  a: Person
  b: Person
  relation: string
  score: number
}

export interface ProximityPath {
  member: Person
  hops: number
  // 0-100: the path's own strength (edge strengths multiplied, hop penalty applied).
  strength: number
  // Member first, prospect last.
  people: Person[]
  edges: ProximityEdge[]
}

export interface ProximityMember {
  member: Person
  strength: number
}

export interface Proximity {
  prospect_id: string
  score: number
  state: ProximityState
  path_count: number
  members: ProximityMember[]
  // The best few paths, best first.
  paths: ProximityPath[]
  formula_version: number
  max_hops: number
}

// Under the ['links'] prefix: every link create/edit/delete (useLinkMutations) refreshes this read as well.
export const proximityKey = (prospectId: string) => [...linkKeys.all, 'proximity', 'prospect', prospectId] as const

// `null` = no saved prospect yet (the new-prospect form): nothing is requested.
export function useProspectProximity(prospectId: string | null) {
  return useQuery({
    queryKey: proximityKey(prospectId ?? ''),
    queryFn: ({ signal }) => apiGet<Proximity>(`/links/proximity/prospect/${encodeURIComponent(prospectId ?? '')}`, signal),
    enabled: prospectId !== null,
  })
}
