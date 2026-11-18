import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'

import { apiGet, apiRequest } from './client'
import { refreshAfterWrite } from './refresh'

// Mirrors backend/app/api/routes/links.py: relational links between people — prospects and members of the
// organisation — with a relation (« frère », « amis »…) and a strength from 0 to 100. A link is undirected.

export type PersonKind = 'prospect' | 'member'

export interface Person {
  kind: PersonKind
  id: string
  name: string
  company_id: string | null
  company_name: string | null
}

export interface PersonLink {
  id: string
  a: Person
  b: Person
  relation: string
  score: number
  note: string | null
}

export interface GraphCompany {
  id: string | null
  name: string
  prospects: Person[]
}

export interface LinkGraph {
  members: Person[]
  companies: GraphCompany[]
  links: PersonLink[]
}

export interface GraphFilters {
  min_score: number
  relation: string | null
  company_id: string | null
  include_unlinked: boolean
}

export interface LinkInput {
  a: { kind: PersonKind; id: string }
  b: { kind: PersonKind; id: string }
  relation: string
  score: number
  note?: string | null
}

export const linkKeys = {
  all: ['links'] as const,
  graph: (filters: GraphFilters) => ['links', 'graph', filters] as const,
  person: (kind: PersonKind, id: string) => ['links', 'person', kind, id] as const,
  relations: ['links', 'relations'] as const,
}

// The person at the other end of a link seen from `own`.
export function otherSide(link: PersonLink, own: { kind: PersonKind; id: string }): Person {
  return link.a.kind === own.kind && link.a.id === own.id ? link.b : link.a
}

export function useLinkGraph(filters: GraphFilters) {
  return useQuery({
    queryKey: linkKeys.graph(filters),
    queryFn: ({ signal }) => {
      const params = new URLSearchParams({ min_score: String(filters.min_score) })
      if (filters.relation) params.set('relation', filters.relation)
      if (filters.company_id) params.set('company_id', filters.company_id)
      if (filters.include_unlinked) params.set('include_unlinked', 'true')
      return apiGet<LinkGraph>(`/links/graph?${params.toString()}`, signal)
    },
  })
}

export function usePersonLinks(kind: PersonKind, id: string) {
  return useQuery({
    queryKey: linkKeys.person(kind, id),
    queryFn: ({ signal }) => apiGet<PersonLink[]>(`/links/person/${kind}/${encodeURIComponent(id)}`, signal),
  })
}

// The relation labels already used, most used first: suggestions for the next link.
export function useRelationLabels() {
  return useQuery({
    queryKey: linkKeys.relations,
    queryFn: ({ signal }) => apiGet<string[]>('/links/relations', signal),
  })
}

export function useLinkMutations() {
  const queryClient = useQueryClient()
  const written = () => refreshAfterWrite(queryClient, [linkKeys.all])
  return {
    create: useMutation({
      mutationFn: (input: LinkInput) => apiRequest<PersonLink>('POST', '/links', { body: input }),
      onSuccess: written,
    }),
    update: useMutation({
      mutationFn: ({ id, patch }: { id: string; patch: { relation?: string; score?: number; note?: string | null } }) =>
        apiRequest<PersonLink>('PATCH', `/links/${encodeURIComponent(id)}`, { body: patch }),
      onSuccess: written,
    }),
    remove: useMutation({
      mutationFn: (id: string) => apiRequest<undefined>('DELETE', `/links/${encodeURIComponent(id)}`),
      onSuccess: written,
    }),
  }
}
