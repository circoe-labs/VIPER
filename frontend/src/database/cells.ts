// Turning API values into grid text, clipboard text and full-value viewer text.
import type { ColumnKind, RowValues } from '../api/explorer'

const pad = (value: number) => String(value).padStart(2, '0')

// ISO-like local time (`2026-09-10 14:03:22`): unambiguous, sortable, and still readable.
export function formatDateTime(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return iso
  const day = `${String(date.getFullYear())}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
  return `${day} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}

// One-line text for a grid cell or a filter chip. NULL is rendered separately by the grid.
export function displayValue(value: unknown, kind: ColumnKind): string {
  if (value === null || value === undefined) return 'NULL'
  if (kind === 'datetime' && typeof value === 'string') return formatDateTime(value)
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  return JSON.stringify(value)
}

// Raw value for the clipboard: strings as stored (timestamps stay ISO 8601 with offset), JSON as JSON, NULL empty.
export function clipboardValue(value: unknown): string {
  if (value === null || value === undefined) return ''
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  return JSON.stringify(value)
}

// Full value for the viewer: JSON (objects, arrays, or JSON text) pretty-printed, everything else as is.
export function fullValueText(value: unknown, kind: ColumnKind): string {
  if (value === null || value === undefined) return ''
  if ((kind === 'json' || kind === 'array') && typeof value === 'string') {
    try {
      return JSON.stringify(JSON.parse(value), null, 2)
    } catch {
      return value
    }
  }
  if (typeof value === 'object') return JSON.stringify(value, null, 2)
  return clipboardValue(value)
}

// Tab-separated values of one row, in column order; tabs/newlines inside values become spaces so it pastes as a
// single spreadsheet row.
export function rowToTsv(values: RowValues, columns: string[]): string {
  return columns.map((column) => clipboardValue(values[column]).replace(/[\t\r\n]+/g, ' ')).join('\t')
}

export function rowToJson(values: RowValues, columns: string[]): string {
  return JSON.stringify(Object.fromEntries(columns.map((column) => [column, values[column] ?? null])), null, 2)
}

// UUIDv7 keys share their time-based prefix, so a narrow column shows both ends (`01a08b50…e87a1734`) instead of
// cutting off the distinctive tail.
export function compactUuid(value: string): string {
  return value.length === 36 ? `${value.slice(0, 8)}…${value.slice(-8)}` : value
}

export function isNumericKind(kind: ColumnKind): boolean {
  return kind === 'integer' || kind === 'number'
}
