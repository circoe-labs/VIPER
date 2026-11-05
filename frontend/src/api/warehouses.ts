import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { apiGet, apiRequest } from './client'
import { refreshAfterWrite } from './refresh'

export interface WarehouseContact {
  full_name: string
  role: string | null
  email: string | null
  linkedin: string | null
}
export interface WarehouseInput {
  name: string
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

export function useWarehouses(search: string, offset: number) {
  return useQuery({
    queryKey: ['warehouses', 'list', search, offset],
    queryFn: ({ signal }) => apiGet<{ items: Warehouse[]; total: number }>(`/warehouses?${new URLSearchParams({ q: search, offset: String(offset), limit: '50' }).toString()}`, signal),
    placeholderData: keepPreviousData,
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
