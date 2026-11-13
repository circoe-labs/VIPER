import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { apiGet, apiRequest } from './client'
import { refreshAfterWrite } from './refresh'

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
  notes: string | null
  contacts: WarehouseContact[]
}
export interface Warehouse extends WarehouseInput {
  id: string
  version: string
  source_reference: string | null
}
export interface WarehousePreview {
  items: WarehouseInput[]
  warehouses: number
  contacts: number
  existing: number
}
export interface WarehouseImportResult { created: number; skipped: number; contacts: number }

export interface WarehouseDraft {
  id: string
  prospecting_category?: 'sme' | 'other' | null
  phase: number
  warehouse_name: string
  contact_name: string
  contact_role: string | null
  source_email: string | null
  recipient: string | null
  subject: string
  body: string
  review_note: string
  revision: number
  validated_at: string | null
  validated_by: string | null
  human_validated?: boolean
  scheduled_at: string | null
  send_state: 'planned' | 'scheduled' | 'sending' | 'uncertain' | 'sent' | 'failed' | null
  recovery_possible?: boolean
}

export function useWarehouseDrafts() {
  return useQuery({ queryKey: ['warehouses', 'drafts'], queryFn: ({ signal }) => apiGet<WarehouseDraft[]>('/warehouses/drafts', signal), refetchInterval: 15000 })
}

export function useWarehouseDispatchStatus() {
  return useQuery({ queryKey: ['warehouses', 'dispatch-status'], queryFn: ({ signal }) => apiGet<{ active: boolean }>('/warehouses/drafts/dispatch-status', signal), refetchInterval: 30000 })
}

export function useWarehouseDraftActions() {
  const client = useQueryClient()
  const refresh = () => client.invalidateQueries({ queryKey: ['warehouses', 'drafts'] })
  return {
    save: useMutation({ mutationFn: ({ id, ...body }: { id: string; revision: number; recipient: string; subject: string; body: string }) => apiRequest<WarehouseDraft>('PUT', `/warehouses/drafts/${id}`, { body }), onSuccess: refresh }),
    validate: useMutation({ mutationFn: ({ id, revision }: { id: string; revision: number }) => apiRequest<WarehouseDraft>('POST', `/warehouses/drafts/${id}/validate`, { body: { revision } }), onSuccess: refresh }),
    schedule: useMutation({ mutationFn: ({ id, revision, scheduled_at }: { id: string; revision: number; scheduled_at: string }) => apiRequest<WarehouseDraft>('POST', `/warehouses/drafts/${id}/schedule`, { body: { revision, scheduled_at } }), onSuccess: refresh }),
    unschedule: useMutation({ mutationFn: ({ id, revision }: { id: string; revision: number }) => apiRequest<WarehouseDraft>('POST', `/warehouses/drafts/${id}/unschedule`, { body: { revision } }), onSuccess: refresh }),
    scheduleBatch: useMutation({ mutationFn: (body: { scheduled_at: string; drafts: { id: string; revision: number }[] }) => apiRequest<{ scheduled: number }>('POST', '/warehouses/drafts/schedule-batch', { body }), onSuccess: refresh }),
    planBatch: useMutation({ mutationFn: (body: { scheduled_at: string; drafts: { id: string; revision: number }[] }) => apiRequest<{ scheduled: number }>('POST', '/warehouses/drafts/plan-batch', { body }), onSuccess: refresh }),
    recoverBatch: useMutation({ mutationFn: (body: { scheduled_at: string; confirmed_not_sent: true; drafts: { id: string; revision: number }[] }) => apiRequest<{ scheduled: number }>('POST', '/warehouses/drafts/recover-batch', { body }), onSuccess: refresh }),
  }
}

export function useWarehouseCounts() {
  return useQuery({
    queryKey: ['warehouses', 'counts'],
    queryFn: ({ signal }) => apiGet<{ warehouses: number; contacts: number; to_contact: number; sme: number; other: number; unclassified: number }>('/warehouses/counts', signal),
  })
}

export function useWarehouses(search: string, offset: number, toContact = false, category: 'sme' | 'other' | 'unclassified' | null = null) {
  return useQuery({
    queryKey: ['warehouses', 'list', search, offset, toContact, category],
    queryFn: ({ signal }) => apiGet<{ items: Warehouse[]; total: number }>(`/warehouses?${new URLSearchParams({ q: search, offset: String(offset), limit: '50', ...(toContact ? { to_contact: 'true' } : {}), ...(category ? { category } : {}) }).toString()}`, signal),
    placeholderData: (previous, previousQuery) => previousQuery?.queryKey[4] === toContact && previousQuery?.queryKey[5] === category ? previous : undefined,
  })
}
export function useWarehouse(id: string | null) {
  return useQuery({ queryKey: ['warehouses', 'detail', id], enabled: id !== null,
    queryFn: ({ signal }) => apiGet<Warehouse>(`/warehouses/${id ?? ''}`, signal) })
}
export function useWarehouseWrites() {
  const client = useQueryClient()
  const refresh = () => refreshAfterWrite(client, [['warehouses']])
  const upload = (file: File) => { const body = new FormData(); body.append('file', file); return body }
  return {
    save: useMutation({ mutationFn: ({ id, data, version }: { id: string | null; data: WarehouseInput; version?: string }) =>
      id ? apiRequest<Warehouse>('PUT', `/warehouses/${id}`, { body: { ...data, version } }) : apiRequest<Warehouse>('POST', '/warehouses', { body: data }), onSuccess: refresh }),
    preview: useMutation({ mutationFn: (file: File) => apiRequest<WarehousePreview>('POST', '/warehouses/import-preview', { body: upload(file) }) }),
    importFile: useMutation({ mutationFn: (file: File) => apiRequest<WarehouseImportResult>('POST', '/warehouses/import', { body: upload(file) }), onSuccess: refresh }),
  }
}
