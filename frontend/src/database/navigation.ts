// Relationship navigation: a link is just another explorer URL (target table + primary/foreign key filter), so the
// browser history — and the in-page "Retour" button — take the user back to where they came from.
import type { ExplorerColumn, ExplorerReference, RowValues } from '../api/explorer'
import { viewHref } from './explorerView'

// Where the user came from, carried in the history entry of a relationship hop (shown as "Retour à …").
export interface NavigationOrigin {
  table: string
}

function isKeyValue(value: unknown): value is string | number {
  return typeof value === 'string' || typeof value === 'number'
}

// FK cell → the referenced row in its table.
export function referencedRowHref(column: ExplorerColumn, value: unknown): string | null {
  if (!column.foreign_key || !isKeyValue(value)) return null
  const { table, column: target } = column.foreign_key
  return viewHref(table, { filters: [{ column: target, operator: 'eq', value }] })
}

// Row → the rows of another table whose FK points at it (e.g. a company's prospects).
export function referencingRowsHref(reference: ExplorerReference, values: RowValues): string | null {
  const value = values[reference.referenced_column]
  if (!isKeyValue(value)) return null
  return viewHref(reference.table, { filters: [{ column: reference.column, operator: 'eq', value }] })
}

export function readOrigin(state: unknown): NavigationOrigin | null {
  if (typeof state !== 'object' || state === null || !('origin' in state)) return null
  const origin: unknown = state.origin
  if (typeof origin !== 'object' || origin === null) return null
  const { table } = origin as Record<string, unknown>
  return typeof table === 'string' ? { table } : null
}
