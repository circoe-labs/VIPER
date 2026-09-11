// What the grid shows — search, sort, column filters, page — lives in the URL (`/database/<table>?…`), so refresh,
// deep links and browser Back (after FK navigation) restore it. Column layout is per table in localStorage instead.
import type { FilterOperator, FilterScalar, RowsQuery } from '../api/explorer'

export interface SortKey {
  column: string
  desc: boolean
}

export interface ColumnFilter {
  column: string
  operator: FilterOperator
  value?: FilterScalar
  values?: FilterScalar[]
}

export interface ExplorerView {
  search: string
  sort: SortKey[]
  filters: ColumnFilter[]
  page: number
  pageSize: number
}

export const PAGE_SIZES = [50, 100, 250, 500] as const
export const DEFAULT_PAGE_SIZE = 100
export const EMPTY_VIEW: ExplorerView = { search: '', sort: [], filters: [], page: 1, pageSize: DEFAULT_PAGE_SIZE }

const OPERATORS: ReadonlySet<string> = new Set<FilterOperator>([
  'eq',
  'neq',
  'contains',
  'starts_with',
  'gt',
  'gte',
  'lt',
  'lte',
  'is_null',
  'not_null',
  'in',
])

function isScalar(value: unknown): value is FilterScalar {
  return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'
}

// Hand-edited or stale URLs must never break the page: anything malformed is dropped (the API validates again).
function parseFilters(raw: string | null): ColumnFilter[] {
  if (!raw) return []
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return []
  }
  if (!Array.isArray(parsed)) return []
  return parsed.flatMap((item: unknown): ColumnFilter[] => {
    if (typeof item !== 'object' || item === null) return []
    const { column, operator, value, values } = item as Record<string, unknown>
    if (typeof column !== 'string' || typeof operator !== 'string' || !OPERATORS.has(operator)) return []
    const filter: ColumnFilter = { column, operator: operator as FilterOperator }
    if (isScalar(value)) filter.value = value
    if (Array.isArray(values)) filter.values = values.filter(isScalar)
    return [filter]
  })
}

function positiveInt(raw: string | null, fallback: number): number {
  const value = Number(raw)
  return Number.isInteger(value) && value > 0 ? value : fallback
}

export function parseView(params: URLSearchParams): ExplorerView {
  const size = positiveInt(params.get('size'), DEFAULT_PAGE_SIZE)
  return {
    search: params.get('q') ?? '',
    sort: (params.get('sort') ?? '')
      .split(',')
      .filter((key) => key && key !== '-')
      .map((key) => ({ column: key.replace(/^-/, ''), desc: key.startsWith('-') })),
    filters: parseFilters(params.get('filters')),
    page: positiveInt(params.get('page'), 1),
    pageSize: (PAGE_SIZES as readonly number[]).includes(size) ? size : DEFAULT_PAGE_SIZE,
  }
}

// Default values are omitted so plain URLs stay short (`/database/companies`).
export function serializeView(view: ExplorerView): URLSearchParams {
  const params = new URLSearchParams()
  if (view.search) params.set('q', view.search)
  if (view.sort.length > 0) params.set('sort', view.sort.map(sortKeyParam).join(','))
  if (view.filters.length > 0) params.set('filters', JSON.stringify(view.filters))
  if (view.page > 1) params.set('page', String(view.page))
  if (view.pageSize !== DEFAULT_PAGE_SIZE) params.set('size', String(view.pageSize))
  return params
}

export function viewHref(table: string, view: Partial<ExplorerView> = {}): string {
  const params = serializeView({ ...EMPTY_VIEW, ...view }).toString()
  return `/database/${encodeURIComponent(table)}${params ? `?${params}` : ''}`
}

// One row of `table` by its `id` (Prospection's fallback editor, global search).
export function recordHref(table: string, id: string): string {
  return viewHref(table, { filters: [{ column: 'id', operator: 'eq', value: id }] })
}

function sortKeyParam({ column, desc }: SortKey): string {
  return desc ? `-${column}` : column
}

// Header click: ascending → descending → unsorted. Without `additive` the column becomes the only sort key;
// with it (Shift+click) the column is added to / cycled within the existing multi-column sort.
export function nextSort(sort: SortKey[], column: string, additive: boolean): SortKey[] {
  const current = sort.find((key) => key.column === column)
  const next: SortKey | null = !current ? { column, desc: false } : current.desc ? null : { column, desc: true }
  if (!additive) return next ? [next] : []
  if (!current) return [...sort, { column, desc: false }]
  return next ? sort.map((key) => (key.column === column ? next : key)) : sort.filter((key) => key.column !== column)
}

export function toRowsQuery(view: ExplorerView): RowsQuery {
  return {
    filter:
      view.filters.length > 0
        ? {
            type: 'group',
            combinator: 'and',
            conditions: view.filters.map((filter) => ({ type: 'condition', ...filter })),
          }
        : null,
    search: view.search.trim(),
    sort: view.sort.map(sortKeyParam),
    offset: (view.page - 1) * view.pageSize,
    limit: view.pageSize,
  }
}
