// Per-table column layout (order, visibility, width, left pinning), persisted in localStorage and reconciled with
// the table's current columns so schema changes never break a stored layout.
import type { ColumnKind, ExplorerColumn } from '../api/explorer'
import { readStorage, writeStorage } from '../lib/storage'

export interface ColumnState {
  order: string[]
  hidden: string[]
  pinned: string[]
  widths: Record<string, number>
}

export type ColumnAction =
  | { type: 'toggle'; column: string }
  | { type: 'showAll' }
  | { type: 'move'; column: string; offset: -1 | 1 }
  // `before: null` moves the column to the end.
  | { type: 'reorder'; column: string; before: string | null }
  | { type: 'resize'; widths: Record<string, number> }
  | { type: 'resetWidth'; column: string }
  | { type: 'pin'; column: string; pinned: boolean }
  | { type: 'reset'; columns: ExplorerColumn[] }

export const MIN_WIDTH = 72
export const MAX_WIDTH = 960
const STORAGE_PREFIX = 'viper.explorer.columns.'
const STORAGE_VERSION = 1

const KIND_WIDTHS: Record<ColumnKind, number> = {
  text: 220,
  enum: 160,
  integer: 120,
  number: 130,
  boolean: 110,
  datetime: 190,
  date: 140,
  uuid: 180,
  json: 280,
  array: 220,
}

// Wide enough for the header (name + icons) and a typical value of the kind.
export function defaultWidth(column: ExplorerColumn): number {
  return Math.min(MAX_WIDTH, Math.max(KIND_WIDTHS[column.kind], column.name.length * 8 + 112))
}

export function initialColumnState(columns: ExplorerColumn[]): ColumnState {
  return {
    order: columns.map((column) => column.name),
    hidden: [],
    // Primary keys start pinned: the row identity stays visible while scrolling sideways.
    pinned: columns.filter((column) => column.primary_key).map((column) => column.name),
    widths: {},
  }
}

// Drops columns that no longer exist, appends new ones in schema order, clamps widths.
export function reconcile(state: ColumnState, columns: ExplorerColumn[]): ColumnState {
  const names = columns.map((column) => column.name)
  const known = new Set(names)
  const order = state.order.filter((name) => known.has(name))
  order.push(...names.filter((name) => !order.includes(name)))
  const widths: Record<string, number> = {}
  for (const [name, width] of Object.entries(state.widths)) {
    if (known.has(name)) widths[name] = clampWidth(width)
  }
  return {
    order,
    hidden: state.hidden.filter((name) => known.has(name)),
    pinned: state.pinned.filter((name) => known.has(name)),
    widths,
  }
}

function clampWidth(width: number): number {
  return Math.round(Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, width)))
}

// Moves `column` just before `before` (or to the end) in the stored order.
function reorder(state: ColumnState, column: string, before: string | null): ColumnState {
  if (column === before || !state.order.includes(column)) return state
  const order = state.order.filter((name) => name !== column)
  const target = before === null ? order.length : order.indexOf(before)
  if (target < 0) return state
  order.splice(target, 0, column)
  return { ...state, order }
}

export function columnStateReducer(state: ColumnState, action: ColumnAction): ColumnState {
  switch (action.type) {
    case 'toggle': {
      const hidden = state.hidden.includes(action.column)
        ? state.hidden.filter((name) => name !== action.column)
        : [...state.hidden, action.column]
      // At least one column always stays visible.
      return hidden.length >= state.order.length ? state : { ...state, hidden }
    }
    case 'showAll':
      return { ...state, hidden: [] }
    case 'move': {
      // One step left/right among the displayed columns of the same (pinned or scrolling) group.
      const visible = displayOrder(state)
      const index = visible.indexOf(action.column)
      const neighbor = visible[index + action.offset]
      if (index < 0 || neighbor === undefined) return state
      if (state.pinned.includes(action.column) !== state.pinned.includes(neighbor)) return state
      return action.offset < 0 ? reorder(state, action.column, neighbor) : reorder(state, neighbor, action.column)
    }
    case 'reorder':
      return reorder(state, action.column, action.before)
    case 'resize': {
      const widths = { ...state.widths }
      for (const [name, width] of Object.entries(action.widths)) widths[name] = clampWidth(width)
      return { ...state, widths }
    }
    case 'resetWidth':
      return { ...state, widths: Object.fromEntries(Object.entries(state.widths).filter(([name]) => name !== action.column)) }
    case 'pin': {
      const pinned = state.pinned.filter((name) => name !== action.column)
      return { ...state, pinned: action.pinned ? [...pinned, action.column] : pinned }
    }
    case 'reset':
      return initialColumnState(action.columns)
  }
}

// Display order: pinned columns first (in their relative order), then the others.
export function displayOrder(state: ColumnState): string[] {
  const visible = state.order.filter((name) => !state.hidden.includes(name))
  return [...visible.filter((name) => state.pinned.includes(name)), ...visible.filter((name) => !state.pinned.includes(name))]
}

export function loadColumnState(table: string, columns: ExplorerColumn[]): ColumnState {
  const raw = readStorage(STORAGE_PREFIX + table)
  if (raw) {
    try {
      const stored: unknown = JSON.parse(raw)
      if (isStoredState(stored)) return reconcile(stored, columns)
    } catch {
      // Corrupt entry: fall back to the default layout.
    }
  }
  return initialColumnState(columns)
}

const isNames = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((item) => typeof item === 'string')

function isStoredState(value: unknown): value is ColumnState {
  if (typeof value !== 'object' || value === null) return false
  const { version, order, hidden, pinned, widths } = value as Record<string, unknown>
  return (
    version === STORAGE_VERSION &&
    isNames(order) &&
    isNames(hidden) &&
    isNames(pinned) &&
    typeof widths === 'object' &&
    widths !== null &&
    Object.values(widths).every((width) => typeof width === 'number')
  )
}

export function saveColumnState(table: string, state: ColumnState): void {
  writeStorage(STORAGE_PREFIX + table, JSON.stringify({ version: STORAGE_VERSION, ...state }))
}
