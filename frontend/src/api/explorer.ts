import { keepPreviousData, useQuery } from '@tanstack/react-query'

import { apiGet } from './client'

// Mirrors backend/app/api/routes/explorer.py (read-only Database Explorer API).

export type ColumnKind = 'text' | 'enum' | 'integer' | 'number' | 'boolean' | 'datetime' | 'date' | 'uuid' | 'json' | 'array'

export type FilterOperator =
  | 'eq'
  | 'neq'
  | 'contains'
  | 'starts_with'
  | 'gt'
  | 'gte'
  | 'lt'
  | 'lte'
  | 'is_null'
  | 'not_null'
  | 'in'

export type FilterScalar = string | number | boolean

export interface ExplorerColumn {
  name: string
  sql_type: string
  kind: ColumnKind
  nullable: boolean
  default: string | null
  primary_key: boolean
  foreign_key: { table: string; column: string } | null
  allowed_values: string[] | null
  masked: boolean
  filter_operators: FilterOperator[]
  sortable: boolean
  searchable: boolean
}

export interface ExplorerReference {
  table: string
  column: string
  referenced_column: string
}

export interface ExplorerTableSummary {
  name: string
  row_count: number
}

export interface ExplorerTable extends ExplorerTableSummary {
  primary_key: string[]
  columns: ExplorerColumn[]
  referenced_by: ExplorerReference[]
}

export type RowValues = Record<string, unknown>

export interface ExplorerRow {
  values: RowValues
  // Columns whose value was cut in this page; the full value comes from the record endpoint.
  truncated: string[]
}

export interface ExplorerRowPage {
  total: number
  offset: number
  limit: number
  rows: ExplorerRow[]
}

export interface FilterCondition {
  type: 'condition'
  column: string
  operator: FilterOperator
  value?: FilterScalar
  values?: FilterScalar[]
}

export interface FilterGroup {
  type: 'group'
  combinator: 'and' | 'or'
  conditions: (FilterCondition | FilterGroup)[]
}

// Server-side read query: filter AST, global search, multi-column sort ("-column" = descending), paging.
export interface RowsQuery {
  filter: FilterGroup | null
  search: string
  sort: string[]
  offset: number
  limit: number
}

export const explorerKeys = {
  all: ['explorer'] as const,
  tables: ['explorer', 'tables'] as const,
  table: (name: string) => ['explorer', 'table', name] as const,
  rows: (name: string, query: RowsQuery) => ['explorer', 'rows', name, query] as const,
  record: (name: string, key: RowValues) => ['explorer', 'record', name, key] as const,
}

function tablePath(name: string): `/${string}` {
  return `/explorer/tables/${encodeURIComponent(name)}`
}

export function queryParams(query: Omit<RowsQuery, 'offset' | 'limit'>): URLSearchParams {
  const params = new URLSearchParams()
  if (query.search) params.set('q', query.search)
  for (const key of query.sort) params.append('sort', key)
  if (query.filter && query.filter.conditions.length > 0) params.set('filter', JSON.stringify(query.filter))
  return params
}

export function exportUrl(name: string, query: Omit<RowsQuery, 'offset' | 'limit'>): string {
  const params = queryParams(query).toString()
  return `/api${tablePath(name)}/export.csv${params ? `?${params}` : ''}`
}

export function useExplorerTables() {
  return useQuery({
    queryKey: explorerKeys.tables,
    queryFn: ({ signal }) => apiGet<ExplorerTableSummary[]>('/explorer/tables', signal),
  })
}

export function useExplorerTable(name: string) {
  return useQuery({
    queryKey: explorerKeys.table(name),
    queryFn: ({ signal }) => apiGet<ExplorerTable>(tablePath(name), signal),
  })
}

export function useExplorerRows(name: string, query: RowsQuery, enabled: boolean) {
  return useQuery({
    queryKey: explorerKeys.rows(name, query),
    queryFn: ({ signal }) => {
      const params = queryParams(query)
      params.set('offset', String(query.offset))
      params.set('limit', String(query.limit))
      return apiGet<ExplorerRowPage>(`${tablePath(name)}/rows?${params.toString()}`, signal)
    },
    enabled,
    // Keep the current page on screen while the next one (sort, filter, page) loads.
    placeholderData: keepPreviousData,
  })
}

export function useExplorerRecord(name: string, key: RowValues, enabled: boolean) {
  return useQuery({
    queryKey: explorerKeys.record(name, key),
    queryFn: ({ signal }) =>
      apiGet<{ values: RowValues }>(
        `${tablePath(name)}/record?key=${encodeURIComponent(JSON.stringify(key))}`,
        signal,
      ),
    enabled,
  })
}
