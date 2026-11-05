import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'

import { apiGet, apiRequest } from './client'
import { refreshAfterWrite } from './refresh'

// Mirrors backend/app/api/routes/organizations.py. Every answer says what the signed-in person may do (`can_*`,
// `assignable_roles`): the page shows only those actions, and the server checks them again.

export type OrganizationRole = 'admin' | 'manager' | 'member'

export interface OrganizationSummary {
  id: string
  name: string
  email_domain: string | null
  members: number
  created_at: string
}

export interface Member {
  id: string
  email: string
  display_name: string
  role: OrganizationRole
  is_superadmin: boolean
  is_active: boolean
  infomaniak_linked: boolean
  last_login_at: string | null
  can_edit: boolean
  can_change_role: boolean
}

export interface OrganizationDetail {
  organization: OrganizationSummary
  members: Member[]
  assignable_roles: OrganizationRole[]
  can_rename: boolean
}

export interface OrganizationsList {
  organizations: OrganizationSummary[]
  can_create: boolean
}

export interface OrganizationInput {
  name: string
  email_domain: string | null
}

export interface MemberInput {
  email: string
  display_name: string
  role: OrganizationRole
}

export interface MemberPatch {
  role?: OrganizationRole
  is_active?: boolean
  display_name?: string
}

const ROOT = ['organizations'] as const

export function useOrganizations() {
  return useQuery({
    queryKey: ROOT,
    queryFn: ({ signal }) => apiGet<OrganizationsList>('/organizations', signal),
  })
}

export function useOrganization(id: string | null) {
  return useQuery({
    queryKey: [...ROOT, id],
    queryFn: ({ signal }) => apiGet<OrganizationDetail>(`/organizations/${id ?? ''}`, signal),
    enabled: id !== null,
  })
}

function useRefresh() {
  const queryClient = useQueryClient()
  return () => refreshAfterWrite(queryClient, [ROOT])
}

export function useCreateOrganization() {
  const refresh = useRefresh()
  return useMutation({
    mutationFn: (input: OrganizationInput) =>
      apiRequest<OrganizationDetail>('POST', '/organizations', { body: input }),
    onSuccess: refresh,
  })
}

export function useUpdateOrganization(id: string) {
  const refresh = useRefresh()
  return useMutation({
    mutationFn: (input: OrganizationInput) =>
      apiRequest<OrganizationDetail>('PUT', `/organizations/${id}`, { body: input }),
    onSuccess: refresh,
  })
}

export function useAddMember(organizationId: string) {
  const refresh = useRefresh()
  return useMutation({
    mutationFn: (input: MemberInput) =>
      apiRequest<Member>('POST', `/organizations/${organizationId}/members`, { body: input }),
    onSuccess: refresh,
  })
}

export function useUpdateMember(organizationId: string) {
  const refresh = useRefresh()
  return useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: MemberPatch }) =>
      apiRequest<Member>('PATCH', `/organizations/${organizationId}/members/${id}`, { body: patch }),
    onSuccess: refresh,
  })
}

export function useRemoveMember(organizationId: string) {
  const refresh = useRefresh()
  return useMutation({
    mutationFn: (id: string) => apiRequest<undefined>('DELETE', `/organizations/${organizationId}/members/${id}`),
    onSuccess: refresh,
  })
}

export function useDeleteOrganization() {
  const refresh = useRefresh()
  return useMutation({
    mutationFn: (id: string) => apiRequest<undefined>('DELETE', `/organizations/${id}`),
    onSuccess: refresh,
  })
}
