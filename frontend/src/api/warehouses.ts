import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { appendFilters, type ListSort } from './companies'
import { apiGet, apiRequest } from './client'
import type { IdentityDoubt } from './emailIdentity'
import type { FileStatus } from './fileStatus'
import { refreshAfterWrite } from './refresh'
import type { TrackingStatus } from './prospection'

export interface WarehouseContact {
  full_name: string
  role: string | null
  email: string | null
  linkedin: string | null
  to_contact?: boolean
}
export interface WarehouseInput {
  name: string
  prospecting_category?: 'sme' | 'other' | null
  owner_name: string | null
  owner_role: string | null
  owner_email: string | null
  owner_linkedin: string | null
  address: string | null
  postal_code: string | null
  city: string | null
  siret: string | null
  // The building (establishment) of a company this warehouse is; the company follows from it.
  establishment_id?: string | null
  notes: string | null
  contacts: WarehouseContact[]
}
export interface Warehouse extends WarehouseInput {
  id: string
  version: string
  source_reference: string | null
  // Computed file status, what is missing for the next level, and the linked company / building.
  status: FileStatus
  missing: string[]
  company_id: string | null
  company_name: string | null
  building_name: string | null
}
export interface WarehousePreview {
  items: WarehouseInput[]
  warehouses: number
  contacts: number
  existing: number
}
export interface WarehouseImportResult { created: number; skipped: number; contacts: number }

// A mail of the former warehouse pipeline: history, or still programmed. New mails are written from Contact.
export interface WarehouseDraft {
  id: string
  warehouse_id: string
  // The prospect the contact is, once linked.
  prospect_id: string | null
  warehouse_name: string
  contact_name: string
  contact_role: string | null
  recipient: string | null
  subject: string
  body: string
  revision: number
  scheduled_at: string | null
  send_state: 'planned' | 'scheduled' | 'sending' | 'uncertain' | 'sent' | 'failed' | null
  sent_at: string | null
  // Why a scheduled mail did not (certainly) leave, and when.
  failure_code?: string | null
  failed_at?: string | null
  // The recipient looks like someone else's: it does not leave.
  identity_doubt?: IdentityDoubt | null
}

export function useWarehouseDrafts() {
  return useQuery({ queryKey: ['warehouses', 'drafts'], queryFn: ({ signal }) => apiGet<WarehouseDraft[]>('/warehouses/drafts', signal), refetchInterval: 15000 })
}

export function useProspectWarehouseMails(prospectId: string) {
  return useQuery({ queryKey: ['warehouses', 'drafts', prospectId], queryFn: ({ signal }) => apiGet<WarehouseDraft[]>(`/warehouses/drafts?prospect_id=${prospectId}`, signal) })
}

export function useWarehouseDispatchStatus() {
  return useQuery({ queryKey: ['warehouses', 'dispatch-status'], queryFn: ({ signal }) => apiGet<{ active: boolean }>('/warehouses/drafts/dispatch-status', signal), refetchInterval: 30000 })
}

export function useWarehouseDraftActions() {
  const client = useQueryClient()
  const refresh = () => refreshAfterWrite(client, [['warehouses']])
  return {
    unschedule: useMutation({ mutationFn: ({ id, revision }: { id: string; revision: number }) => apiRequest<WarehouseDraft>('POST', `/warehouses/drafts/${id}/unschedule`, { body: { revision } }), onSettled: refresh }),
    resolve: useMutation({ mutationFn: ({ id, ...body }: { id: string; revision: number; sent: boolean }) => apiRequest<WarehouseDraft>('POST', `/warehouses/drafts/${id}/resolve`, { body }), onSettled: refresh }),
  }
}

export type PersonStatus = 'linked' | 'match' | 'ambiguous' | 'new' | 'incomplete' | 'not_a_person'
export interface PersonCandidate {
  prospect_id: string
  first_name: string
  last_name: string
  company_name: string | null
  reasons: ('same_email' | 'same_name' | 'same_company' | 'same_initial')[]
  block: string | null
}
export interface PersonContactState {
  block: string | null
  tracking: TrackingStatus | null
  cohort_code: string | null
  sequence_open: boolean
  sent_count: number
  last_sent_at: string | null
  next_scheduled_at: string | null
  warehouse_pending: boolean
  warehouse_uncounted: number
}
export interface WarehousePerson {
  contact_name: string
  kind: 'contact' | 'owner'
  role: string | null
  emails: string[]
  status: PersonStatus
  // The listing's name read as a first and a last name, to confirm.
  first_name: string
  last_name: string
  civility: 'mr' | 'ms' | null
  candidates: PersonCandidate[]
  prospect: { id: string; first_name: string; last_name: string; company_name: string | null } | null
  state: PersonContactState | null
}
export interface WarehousePeople {
  company_id: string | null
  company_name: string | null
  people: WarehousePerson[]
}
export interface LinkPersonInput {
  contact_name: string
  prospect_id?: string
  create?: { first_name: string; last_name: string; civility: 'mr' | 'ms' | null; company_id: string }
  distinct_confirmed?: boolean
}

export function useWarehousePeople(warehouseId: string, enabled: boolean) {
  return useQuery({ queryKey: ['warehouses', 'people', warehouseId], enabled, queryFn: ({ signal }) => apiGet<WarehousePeople>(`/warehouses/${warehouseId}/people`, signal) })
}

export function useLinkWarehousePerson(warehouseId: string) {
  const client = useQueryClient()
  return useMutation({
    mutationFn: (body: LinkPersonInput) => apiRequest<{ prospect_id: string }>('POST', `/warehouses/${warehouseId}/people`, { body }),
    onSettled: () => refreshAfterWrite(client, [['warehouses'], ['prospects'], ['prospection'], ['contact']]),
  })
}

export function useWarehouseCounts() {
  return useQuery({
    queryKey: ['warehouses', 'counts'],
    queryFn: ({ signal }) => apiGet<{ warehouses: number; contacts: number; to_contact: number; sme: number; other: number; unclassified: number }>('/warehouses/counts', signal),
  })
}

// The Entrepôts filters: any of one filter's values (OR), the filters combined with AND; empty = not filtered.
export interface WarehouseListFilters {
  to_contact?: boolean
  category?: readonly ('sme' | 'other' | 'unclassified')[]
  status?: readonly FileStatus[]
  department?: readonly string[]
  created_from?: string | null
  created_to?: string | null
}

export function useWarehouses(search: string, offset: number, filters: WarehouseListFilters = {}, sort: ListSort = 'name') {
  // A row shows its interlocutors according to « À contacter »: no rows kept from another selection of it.
  const scope = JSON.stringify([filters.to_contact ?? false, filters.category ?? []])
  return useQuery({
    queryKey: ['warehouses', 'list', scope, search, offset, filters, sort],
    queryFn: ({ signal }) => apiGet<{ items: Warehouse[]; total: number }>(`/warehouses?${appendFilters(new URLSearchParams({ q: search, offset: String(offset), limit: '50', ...(sort !== 'name' ? { sort } : {}) }), filters).toString()}`, signal),
    placeholderData: (previous, previousQuery) => previousQuery?.queryKey[2] === scope ? previous : undefined,
  })
}
export function useWarehouse(id: string | null) {
  return useQuery({ queryKey: ['warehouses', 'detail', id], enabled: id !== null,
    queryFn: ({ signal }) => apiGet<Warehouse>(`/warehouses/${id ?? ''}`, signal) })
}
export function useWarehouseWrites() {
  const client = useQueryClient()
  const refresh = () => refreshAfterWrite(client, [['warehouses'], ['prospection', 'filter-options']])
  const upload = (file: File) => { const body = new FormData(); body.append('file', file); return body }
  return {
    save: useMutation({ mutationFn: ({ id, data, version }: { id: string | null; data: WarehouseInput; version?: string }) =>
      id ? apiRequest<Warehouse>('PUT', `/warehouses/${id}`, { body: { ...data, version } }) : apiRequest<Warehouse>('POST', '/warehouses', { body: data }), onSuccess: refresh }),
    preview: useMutation({ mutationFn: (file: File) => apiRequest<WarehousePreview>('POST', '/warehouses/import-preview', { body: upload(file) }) }),
    importFile: useMutation({ mutationFn: (file: File) => apiRequest<WarehouseImportResult>('POST', '/warehouses/import', { body: upload(file) }), onSuccess: refresh }),
  }
}
