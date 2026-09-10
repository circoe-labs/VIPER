import { keepPreviousData, useQuery } from '@tanstack/react-query'

import { apiGet, apiRequest } from './client'

// Mirrors backend/app/api/routes/explorer.py (reads) and explorer_writes.py (staged change sets, delete checks).

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
  // Staged writes: may change on an existing row / be given on a new row; the reason explains a refusal.
  updatable: boolean
  insertable: boolean
  read_only_reason: string | null
  required_on_insert: boolean
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
  // null when the operation is allowed, else why not (French, shown to the user).
  update_refused: string | null
  insert_refused: string | null
  delete_refused: string | null
  // Several rows may be deleted at once (no deletion cascades from this table).
  bulk_delete: boolean
  // Column holding the row version sent back with updates and deletes (optimistic concurrency).
  version_column: string | null
  // Columns naming a row for people (foreign-key pickers).
  label_columns: string[]
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

// A staged change set for one table (POST /changes). Values are JSON scalars; datetimes are ISO 8601 with offset.
export interface ChangeSet {
  updates: { key: RowValues; version: string | null; values: RowValues }[]
  inserts: { values: RowValues }[]
  deletes: { key: RowValues; version: string | null }[]
}

export type ChangeOperation = 'update' | 'insert' | 'delete'

// One refused change: `index` points into the matching list of the change set; `column` null = the whole row.
export interface ChangeError {
  operation: ChangeOperation
  index: number
  column: string | null
  code: string
  message: string
}

export interface ChangeSetResult {
  updated: number
  inserted: number
  deleted: number
  inserted_keys: RowValues[]
}

export type DeleteAction = 'restrict' | 'cascade' | 'set_null'

export interface DeleteCheck {
  rows: number
  allowed: boolean
  blockers: string[]
  // `table`/`column` are null for data the explorer does not expose.
  effects: { table: string | null; column: string | null; action: DeleteAction; count: number; depth: number }[]
}

export const explorerKeys = {
  all: ['explorer'] as const,
  tables: ['explorer', 'tables'] as const,
  table: (name: string) => ['explorer', 'table', name] as const,
  rows: (name: string, query: RowsQuery) => ['explorer', 'rows', name, query] as const,
  record: (name: string, key: RowValues) => ['explorer', 'record', name, key] as const,
  deleteCheck: (name: string, keys: RowValues[]) => ['explorer', 'delete-check', name, keys] as const,
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

// Read-only SQL console (POST /explorer/sql). Values are JSON-safe (timestamps as ISO text, big integers as text).
export interface SqlResult {
  columns: { name: string; type: string }[]
  rows: unknown[][]
  // [row, column] of the cells cut by the server.
  truncated_cells: [number, number][]
  row_count: number
  // More rows exist than `max_rows`.
  truncated: boolean
  max_rows: number
  duration_ms: number
}

// `detail` of a refused query: French message, PostgreSQL's own message, 1-based position in the query.
export interface SqlError {
  code: string
  message: string
  detail: string | null
  position: number | null
}

export function runSql(sql: string): Promise<SqlResult> {
  return apiRequest<SqlResult>('POST', '/explorer/sql', { body: { sql } })
}

export function sqlError(detail: unknown): SqlError | null {
  if (typeof detail !== 'object' || detail === null || !('code' in detail) || !('message' in detail)) return null
  return detail as SqlError
}

// Applies the change set all or nothing. A refusal is an ApiError (422, or 409 when a row changed meanwhile) whose
// detail carries every error (`changeErrors`).
export function saveChanges(name: string, changes: ChangeSet): Promise<ChangeSetResult> {
  return apiRequest<ChangeSetResult>('POST', `${tablePath(name)}/changes`, { body: changes })
}

export function changeErrors(detail: unknown): ChangeError[] | null {
  if (typeof detail !== 'object' || detail === null || !('errors' in detail) || !Array.isArray(detail.errors)) {
    return null
  }
  return detail.errors as ChangeError[]
}

export function useDeleteCheck(name: string, keys: RowValues[]) {
  return useQuery({
    queryKey: explorerKeys.deleteCheck(name, keys),
    queryFn: ({ signal }) => {
      const params = new URLSearchParams(keys.map((key) => ['key', JSON.stringify(key)]))
      return apiGet<DeleteCheck>(`${tablePath(name)}/delete-check?${params.toString()}`, signal)
    },
    // Always fresh: the answer depends on rows that may have changed since the last check.
    gcTime: 0,
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
