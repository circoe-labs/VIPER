// Column filter vocabulary (French labels), user input parsing per column kind, and "filter by this value".
import type { ExplorerColumn, FilterOperator, FilterScalar } from '../api/explorer'
import { displayValue } from './cells'
import type { ColumnFilter } from './explorerView'

const LABELS: Record<FilterOperator, string> = {
  contains: 'contient',
  starts_with: 'commence par',
  eq: 'est égal à',
  neq: 'est différent de',
  gt: 'est supérieur à',
  gte: 'est supérieur ou égal à',
  lt: 'est inférieur à',
  lte: 'est inférieur ou égal à',
  in: 'fait partie de',
  is_null: 'est vide (NULL)',
  not_null: 'n’est pas vide',
}

const DATE_LABELS: Partial<Record<FilterOperator, string>> = {
  eq: 'est le',
  neq: 'n’est pas le',
  gt: 'après le',
  gte: 'à partir du',
  lt: 'avant le',
  lte: 'jusqu’au',
}

export function operatorLabel(operator: FilterOperator, column: ExplorerColumn): string {
  const temporal = column.kind === 'datetime' || column.kind === 'date'
  return (temporal ? DATE_LABELS[operator] : undefined) ?? LABELS[operator]
}

export function needsValue(operator: FilterOperator): boolean {
  return operator !== 'is_null' && operator !== 'not_null'
}

function formatScalar(value: FilterScalar, column: ExplorerColumn | undefined): string {
  return column ? displayValue(value, column.kind) : String(value)
}

// Chip text, e.g. `display_name contient « fret »`.
export function describeFilter(filter: ColumnFilter, column: ExplorerColumn | undefined): string {
  const label = column ? operatorLabel(filter.operator, column) : LABELS[filter.operator]
  if (!needsValue(filter.operator)) return `${filter.column} ${label}`
  const values = filter.operator === 'in' ? (filter.values ?? []) : filter.value === undefined ? [] : [filter.value]
  return `${filter.column} ${label} ${values.map((value) => `« ${formatScalar(value, column)} »`).join(', ')}`
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const UUID_PREFIX = /^[0-9a-f-]+$/i
const INTEGER = /^-?\d+$/

type Parsed = { ok: true; value: FilterScalar } | { ok: false; error: string }

function parseScalar(raw: string, column: ExplorerColumn, operator: FilterOperator): Parsed {
  const text = raw.trim()
  if (!text) return { ok: false, error: 'Saisissez une valeur.' }
  if (operator === 'contains' || operator === 'starts_with') {
    if (column.kind === 'uuid' && !UUID_PREFIX.test(text)) {
      return { ok: false, error: 'Un identifiant ne contient que des chiffres, des lettres a–f et des tirets.' }
    }
    return { ok: true, value: text }
  }
  switch (column.kind) {
    case 'integer':
      return INTEGER.test(text) && Number.isSafeInteger(Number(text))
        ? { ok: true, value: Number(text) }
        : { ok: false, error: 'Nombre entier attendu.' }
    case 'number': {
      const value = Number(text.replace(',', '.'))
      return Number.isFinite(value) ? { ok: true, value } : { ok: false, error: 'Nombre attendu.' }
    }
    case 'boolean':
      return text === 'true' || text === 'false'
        ? { ok: true, value: text === 'true' }
        : { ok: false, error: 'Choisissez vrai ou faux.' }
    case 'datetime': {
      // `datetime-local` input (browser time zone) → absolute ISO 8601 instant for the API.
      const date = new Date(text)
      return Number.isNaN(date.getTime())
        ? { ok: false, error: 'Date et heure attendues.' }
        : { ok: true, value: date.toISOString() }
    }
    case 'date':
      return /^\d{4}-\d{2}-\d{2}$/.test(text) ? { ok: true, value: text } : { ok: false, error: 'Date attendue.' }
    case 'uuid':
      return UUID.test(text) ? { ok: true, value: text.toLowerCase() } : { ok: false, error: 'Identifiant (UUID) complet attendu.' }
    case 'enum':
      return column.allowed_values?.includes(text)
        ? { ok: true, value: text }
        : { ok: false, error: 'Choisissez une valeur autorisée.' }
    default:
      return { ok: true, value: text }
  }
}

export type FilterInput = { ok: true; filter: ColumnFilter } | { ok: false; error: string }

// Builds a filter from the column filter editor. `raw` for `in` is a comma- or line-separated list.
export function buildFilter(column: ExplorerColumn, operator: FilterOperator, raw: string): FilterInput {
  if (!needsValue(operator)) return { ok: true, filter: { column: column.name, operator } }
  if (operator === 'in') {
    const items = raw
      .split(/[\n,;]/)
      .map((item) => item.trim())
      .filter(Boolean)
    if (items.length === 0) return { ok: false, error: 'Saisissez au moins une valeur.' }
    const values: FilterScalar[] = []
    for (const item of items) {
      const parsed = parseScalar(item, column, operator)
      if (!parsed.ok) return { ok: false, error: `« ${item} » : ${parsed.error}` }
      values.push(parsed.value)
    }
    return { ok: true, filter: { column: column.name, operator, values } }
  }
  const parsed = parseScalar(raw, column, operator)
  return parsed.ok ? { ok: true, filter: { column: column.name, operator, value: parsed.value } } : parsed
}

// Context-menu "Filtrer sur cette valeur" / "Exclure cette valeur". NULL maps to is_null / not_null; values that
// cannot be compared for equality (JSON, arrays) or masked columns give no filter.
export function filterForValue(column: ExplorerColumn, value: unknown, exclude = false): ColumnFilter | null {
  if (value === null || value === undefined) {
    const operator: FilterOperator = exclude ? 'not_null' : 'is_null'
    return column.filter_operators.includes(operator) ? { column: column.name, operator } : null
  }
  const operator: FilterOperator = exclude ? 'neq' : 'eq'
  if (!column.filter_operators.includes(operator)) return null
  if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') return null
  return { column: column.name, operator, value }
}
