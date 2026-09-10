// Cell editing rules: whether a cell may be edited (and why not), and how editor text becomes a value for the API.
// The server validates everything again; these checks only give immediate feedback.
import type { ExplorerColumn, ExplorerTable } from '../api/explorer'
import type { RowStatus } from './staging'

export type Editability = { editable: true } | { editable: false; reason: string }

const DELETED_ROW = 'Ligne marquée pour suppression : annulez la suppression pour la modifier.'

export function cellEditability(meta: ExplorerTable, column: ExplorerColumn, status: RowStatus): Editability {
  if (status === 'deleted') return { editable: false, reason: DELETED_ROW }
  const allowed = status === 'new' ? column.insertable : column.updatable
  if (allowed) return { editable: true }
  const tableReason = status === 'new' ? meta.insert_refused : meta.update_refused
  return { editable: false, reason: column.read_only_reason ?? tableReason ?? 'Colonne en lecture seule.' }
}

// Whether some cell of an existing row can be edited at all (the table is not read-only for updates).
export function tableIsEditable(meta: ExplorerTable): boolean {
  return meta.update_refused === null && meta.columns.some((column) => column.updatable)
}

export type ParsedInput = { ok: true; value: unknown } | { ok: false; message: string }

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const INTEGER = /^[+-]?\d+$/
const INT32 = 2 ** 31 - 1

// varchar(255) → 255; unbounded text → null.
export function maxLength(column: ExplorerColumn): number | null {
  const match = /\((\d+)\)/.exec(column.sql_type)
  return column.kind === 'text' && match?.[1] ? Number(match[1]) : null
}

// Editor text → API value. An empty text is NULL where the column allows it (a cleared cell means "no value").
export function parseInput(column: ExplorerColumn, text: string, original: unknown): ParsedInput {
  if (text === '' && column.nullable) return { ok: true, value: null }
  switch (column.kind) {
    case 'integer': {
      const value = Number(text)
      if (!INTEGER.test(text.trim()) || Math.abs(value) > INT32) return { ok: false, message: 'Nombre entier attendu.' }
      return { ok: true, value }
    }
    case 'number': {
      const value = Number(text.replace(',', '.'))
      return text.trim() && Number.isFinite(value) ? { ok: true, value } : { ok: false, message: 'Nombre attendu.' }
    }
    case 'uuid':
      return UUID.test(text.trim()) ? { ok: true, value: text.trim().toLowerCase() } : { ok: false, message: 'Identifiant UUID attendu.' }
    case 'datetime': {
      const date = new Date(text)
      if (!text || Number.isNaN(date.getTime())) return { ok: false, message: 'Date et heure attendues.' }
      // Same instant as before (the local editor reformats it): keep the stored text, so nothing is staged.
      if (typeof original === 'string' && new Date(original).getTime() === date.getTime()) return { ok: true, value: original }
      return { ok: true, value: date.toISOString() }
    }
    case 'date':
      return /^\d{4}-\d{2}-\d{2}$/.test(text) ? { ok: true, value: text } : { ok: false, message: 'Date attendue.' }
    case 'boolean':
      return text === 'true' || text === 'false' ? { ok: true, value: text === 'true' } : { ok: false, message: 'Vrai ou faux attendu.' }
    case 'enum':
      return column.allowed_values?.includes(text) ? { ok: true, value: text } : { ok: false, message: 'Valeur de la liste attendue.' }
    default: {
      const limit = maxLength(column)
      if (limit !== null && text.length > limit) return { ok: false, message: `${String(limit)} caractères au maximum.` }
      return { ok: true, value: text }
    }
  }
}

const pad = (value: number) => String(value).padStart(2, '0')

// ISO 8601 → `YYYY-MM-DDTHH:mm:ss` in local time, the format of <input type="datetime-local">.
export function toLocalInput(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return ''
  const day = `${String(date.getFullYear())}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
  return `${day}T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}

// Initial editor text for a stored value.
export function editorText(column: ExplorerColumn, value: unknown): string {
  if (value === null || value === undefined) return ''
  if (column.kind === 'datetime' && typeof value === 'string') return toLocalInput(value)
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  return JSON.stringify(value)
}

// Kinds edited in a free text field (typing a character on the cell starts editing with it).
export function isTypedKind(column: ExplorerColumn): boolean {
  return ['text', 'integer', 'number', 'uuid'].includes(column.kind)
}
