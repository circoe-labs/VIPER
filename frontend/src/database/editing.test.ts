import { describe, expect, it } from 'vitest'

import { column, companiesTable, prospectsTable } from '../test/explorerFixtures'
import { cellEditability, editorText, maxLength, parseInput, toLocalInput } from './editing'

const [idColumn, displayName, sizeLabel] = companiesTable.columns
const activity = prospectsTable.columns.find((item) => item.name === 'activity_status')
const legacy = prospectsTable.columns.find((item) => item.name === 'legacy_metadata')
if (!idColumn || !displayName || !sizeLabel || !activity || !legacy) throw new Error('fixture')

describe('cellEditability', () => {
  it('allows updatable columns of existing rows and insertable columns of new rows', () => {
    expect(cellEditability(companiesTable, displayName, null)).toEqual({ editable: true })
    expect(cellEditability(companiesTable, displayName, 'new')).toEqual({ editable: true })
    expect(cellEditability(companiesTable, idColumn, null)).toEqual({
      editable: false,
      reason: 'Clé primaire générée à la création.',
    })
  })

  it('explains why with the column reason, else the table reason', () => {
    const parent = column('prospect_id', { updatable: false, insertable: true, read_only_reason: 'Rattachement fixé.' })
    const table = { ...prospectsTable, update_refused: 'Table en lecture seule.' }

    expect(cellEditability(prospectsTable, legacy, null)).toMatchObject({ reason: 'Valeur structurée (JSON ou liste) : lecture seule.' })
    expect(cellEditability(prospectsTable, parent, 'new')).toEqual({ editable: true })
    expect(cellEditability(prospectsTable, parent, null)).toMatchObject({ editable: false, reason: 'Rattachement fixé.' })
    expect(cellEditability(table, column('x', { updatable: false }), null)).toMatchObject({ reason: 'Table en lecture seule.' })
  })

  it('refuses every cell of a row marked for deletion', () => {
    expect(cellEditability(companiesTable, displayName, 'deleted')).toMatchObject({ editable: false })
  })
})

describe('parseInput', () => {
  it('turns an empty text into NULL only where the column allows it', () => {
    expect(parseInput(sizeLabel, '', 'x')).toEqual({ ok: true, value: null })
    expect(parseInput(displayName, '', 'x')).toEqual({ ok: true, value: '' })
  })

  it('checks numbers, identifiers, choices and lengths', () => {
    const integer = column('rows_total', { kind: 'integer', sql_type: 'integer', nullable: false })
    const uuid = column('role_id', { kind: 'uuid', sql_type: 'uuid' })
    const flag = column('is_primary', { kind: 'boolean', sql_type: 'boolean', nullable: false })

    expect(parseInput(integer, ' 42 ', 0)).toEqual({ ok: true, value: 42 })
    expect(parseInput(integer, '4,5', 0)).toEqual({ ok: false, message: 'Nombre entier attendu.' })
    expect(parseInput(uuid, '01A00000-0000-7000-8000-000000000001', null)).toEqual({
      ok: true,
      value: '01a00000-0000-7000-8000-000000000001',
    })
    expect(parseInput(uuid, 'abc', null)).toMatchObject({ ok: false })
    expect(parseInput(flag, 'false', true)).toEqual({ ok: true, value: false })
    expect(parseInput(activity, 'inactive', 'active')).toEqual({ ok: true, value: 'inactive' })
    expect(parseInput(activity, 'retired', 'active')).toMatchObject({ ok: false })
    expect(maxLength(sizeLabel)).toBe(100)
    expect(parseInput(sizeLabel, 'x'.repeat(101), null)).toEqual({ ok: false, message: '100 caractères au maximum.' })
  })

  it('keeps the stored text of an unchanged instant and sends others as UTC ISO 8601', () => {
    const when = column('appointment_at', { kind: 'datetime', sql_type: 'timestamp with time zone' })
    const stored = '2026-09-01T09:30:00Z'

    expect(parseInput(when, toLocalInput(stored), stored)).toEqual({ ok: true, value: stored })
    const later = new Date('2026-09-02T09:30:00Z')
    expect(parseInput(when, toLocalInput(later.toISOString()), stored)).toEqual({ ok: true, value: later.toISOString() })
    expect(parseInput(when, 'demain', stored)).toMatchObject({ ok: false })
  })

  it('shows stored values as editor text', () => {
    expect(editorText(sizeLabel, null)).toBe('')
    expect(editorText(column('n', { kind: 'integer' }), 3)).toBe('3')
    expect(editorText(column('when', { kind: 'datetime' }), '2026-09-01T09:30:00Z')).toBe(toLocalInput('2026-09-01T09:30:00Z'))
    expect(toLocalInput('2026-09-01T09:30:00Z')).toMatch(/^2026-09-0[12]T\d{2}:30:00$/)
  })
})
