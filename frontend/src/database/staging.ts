// Staged changes of one table: cell edits, new rows and deletions kept in the browser until "Enregistrer" sends them
// as one change set (all or nothing, server-side). Pure reducer + selectors, so edit/cancel rules are unit-tested.
import type { ChangeError, ChangeOperation, ChangeSet, ExplorerTable, RowValues } from '../api/explorer'

// An existing row, as read from the page when the user first touched it.
export interface SourceRow {
  id: string
  key: RowValues
  // The row's version (`updated_at`) at that moment: the server refuses the change if the row moved since.
  version: string | null
  original: RowValues
}

export interface StagedUpdate extends SourceRow {
  values: RowValues
}

export interface StagedInsert {
  id: string
  values: RowValues
}

export type StagedDelete = SourceRow

export interface StagedError {
  // null: the error concerns the whole row.
  column: string | null
  message: string
}

export interface Staging {
  updates: StagedUpdate[]
  inserts: StagedInsert[]
  deletes: StagedDelete[]
  // Server errors of the last save, by entry id.
  errors: Record<string, StagedError[]>
  nextInsert: number
}

export const EMPTY_STAGING: Staging = { updates: [], inserts: [], deletes: [], errors: {}, nextInsert: 1 }

export type StagingAction =
  | { type: 'edit'; row: SourceRow; column: string; value: unknown }
  | { type: 'editNew'; id: string; column: string; value: unknown }
  | { type: 'addRow' }
  | { type: 'delete'; rows: SourceRow[] }
  | { type: 'revertCell'; id: string; column: string }
  | { type: 'revert'; id: string }
  | { type: 'setErrors'; errors: Record<string, StagedError[]> }
  | { type: 'clear' }

// Stable identity of an existing row: its primary-key values.
export function rowId(primaryKey: string[], values: RowValues): string {
  return JSON.stringify(primaryKey.map((name) => values[name] ?? null))
}

export function sourceRow(meta: ExplorerTable, values: RowValues): SourceRow {
  const version = meta.version_column ? values[meta.version_column] : null
  return {
    id: rowId(meta.primary_key, values),
    key: Object.fromEntries(meta.primary_key.map((name) => [name, values[name]])),
    version: typeof version === 'string' ? version : null,
    original: values,
  }
}

export function newRowId(staging: Staging): string {
  return `new-${String(staging.nextInsert)}`
}

function omit<T>(record: Record<string, T>, name: string): Record<string, T> {
  return Object.fromEntries(Object.entries(record).filter(([key]) => key !== name))
}

// Drops the errors of an entry (only those of `column` when given).
function withoutErrors(errors: Record<string, StagedError[]>, id: string, column?: string) {
  const kept = column === undefined ? [] : (errors[id] ?? []).filter((error) => error.column !== column)
  return kept.length > 0 ? { ...errors, [id]: kept } : omit(errors, id)
}

export function stagingReducer(state: Staging, action: StagingAction): Staging {
  switch (action.type) {
    case 'edit': {
      const { row, column, value } = action
      if (state.deletes.some((item) => item.id === row.id)) return state
      const existing = state.updates.find((item) => item.id === row.id)
      const base = existing ?? { ...row, values: {} }
      // Typing the original value back is not a change.
      const values = Object.is(base.original[column], value) ? omit(base.values, column) : { ...base.values, [column]: value }
      const changed = Object.keys(values).length > 0 ? [{ ...base, values }] : []
      const updates = existing
        ? state.updates.flatMap((item) => (item.id === row.id ? changed : [item]))
        : [...state.updates, ...changed]
      return { ...state, updates, errors: withoutErrors(state.errors, row.id, column) }
    }
    case 'editNew':
      return {
        ...state,
        inserts: state.inserts.map((item) => (item.id === action.id ? { ...item, values: { ...item.values, [action.column]: action.value } } : item)),
        errors: withoutErrors(state.errors, action.id, action.column),
      }
    case 'addRow':
      return { ...state, inserts: [{ id: newRowId(state), values: {} }, ...state.inserts], nextInsert: state.nextInsert + 1 }
    case 'delete': {
      const ids = new Set(action.rows.map((row) => row.id))
      const known = new Set(state.deletes.map((item) => item.id))
      const fresh: SourceRow[] = []
      for (const row of action.rows) {
        if (known.has(row.id)) continue
        known.add(row.id)
        fresh.push(row)
      }
      // A deleted row's pending edits are dropped: they would be lost anyway.
      return {
        ...state,
        updates: state.updates.filter((item) => !ids.has(item.id)),
        deletes: [...state.deletes, ...fresh],
        errors: Object.fromEntries(Object.entries(state.errors).filter(([id]) => !ids.has(id))),
      }
    }
    case 'revertCell': {
      const insert = state.inserts.find((item) => item.id === action.id)
      if (insert) {
        return {
          ...state,
          inserts: state.inserts.map((item) => (item.id === action.id ? { ...item, values: omit(item.values, action.column) } : item)),
          errors: withoutErrors(state.errors, action.id, action.column),
        }
      }
      const updates = state.updates.flatMap((item) => {
        if (item.id !== action.id) return [item]
        const values = omit(item.values, action.column)
        return Object.keys(values).length > 0 ? [{ ...item, values }] : []
      })
      return { ...state, updates, errors: withoutErrors(state.errors, action.id, action.column) }
    }
    case 'revert':
      return {
        ...state,
        updates: state.updates.filter((item) => item.id !== action.id),
        inserts: state.inserts.filter((item) => item.id !== action.id),
        deletes: state.deletes.filter((item) => item.id !== action.id),
        errors: withoutErrors(state.errors, action.id),
      }
    case 'setErrors':
      return { ...state, errors: action.errors }
    case 'clear':
      return EMPTY_STAGING
  }
}

export interface ChangeSummary {
  cells: number
  inserts: number
  deletes: number
  total: number
}

export function summarize(state: Staging): ChangeSummary {
  const cells = state.updates.reduce((count, item) => count + Object.keys(item.values).length, 0)
  return { cells, inserts: state.inserts.length, deletes: state.deletes.length, total: cells + state.inserts.length + state.deletes.length }
}

export function isDirty(state: Staging): boolean {
  return state.updates.length + state.inserts.length + state.deletes.length > 0
}

export function errorCount(state: Staging): number {
  return Object.values(state.errors).reduce((count, errors) => count + errors.length, 0)
}

export type RowStatus = 'new' | 'updated' | 'deleted' | null

export function rowStatus(state: Staging, id: string): RowStatus {
  if (state.inserts.some((item) => item.id === id)) return 'new'
  if (state.deletes.some((item) => item.id === id)) return 'deleted'
  if (state.updates.some((item) => item.id === id)) return 'updated'
  return null
}

// Staged values of an existing row (edited cells only).
export function stagedValues(state: Staging, id: string): RowValues | undefined {
  return state.updates.find((item) => item.id === id)?.values
}

export interface ChangeSetRequest {
  changes: ChangeSet
  // Entry id behind each position of the change set's lists, to put server errors back on the right rows.
  ids: Record<ChangeOperation, string[]>
}

// Inserts are sent oldest first (they are displayed newest first).
export function toChangeSet(state: Staging): ChangeSetRequest {
  const inserts = [...state.inserts].reverse()
  return {
    changes: {
      updates: state.updates.map(({ key, version, values }) => ({ key, version, values })),
      inserts: inserts.map(({ values }) => ({ values })),
      deletes: state.deletes.map(({ key, version }) => ({ key, version })),
    },
    ids: {
      update: state.updates.map((item) => item.id),
      insert: inserts.map((item) => item.id),
      delete: state.deletes.map((item) => item.id),
    },
  }
}

export function errorsById(ids: ChangeSetRequest['ids'], errors: ChangeError[]): Record<string, StagedError[]> {
  const result: Record<string, StagedError[]> = {}
  for (const error of errors) {
    const id = ids[error.operation][error.index]
    if (id === undefined) continue
    ;(result[id] ??= []).push({ column: error.column, message: error.message })
  }
  return result
}
