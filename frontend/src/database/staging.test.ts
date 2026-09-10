import { describe, expect, it } from 'vitest'

import { COMPANY_IDS, companiesTable, companyRows } from '../test/explorerFixtures'
import {
  EMPTY_STAGING,
  errorCount,
  errorsById,
  isDirty,
  newRowId,
  rowStatus,
  sourceRow,
  type Staging,
  type StagingAction,
  stagedValues,
  stagingReducer,
  summarize,
  toChangeSet,
} from './staging'

const [first, second] = companyRows.map((row) => sourceRow(companiesTable, row.values))
if (!first || !second) throw new Error('fixture')

function run(...actions: StagingAction[]): Staging {
  return actions.reduce(stagingReducer, EMPTY_STAGING)
}

describe('staged cell edits', () => {
  it('keeps the key, the version read and the original values of an edited row', () => {
    const state = run({ type: 'edit', row: first, column: 'display_name', value: 'Transports Modifiés SARL' })

    expect(first.key).toEqual({ id: COMPANY_IDS[0] })
    expect(first.version).toBe('2026-09-01T09:30:00Z')
    expect(stagedValues(state, first.id)).toEqual({ display_name: 'Transports Modifiés SARL' })
    expect(rowStatus(state, first.id)).toBe('updated')
    expect(summarize(state)).toEqual({ cells: 1, inserts: 0, deletes: 0, total: 1 })
  })

  it('forgets an edit that restores the original value', () => {
    const state = run(
      { type: 'edit', row: first, column: 'display_name', value: 'Autre' },
      { type: 'edit', row: first, column: 'size_label', value: '50-249' },
      { type: 'edit', row: first, column: 'display_name', value: 'Transports Exemple SARL' },
    )

    expect(stagedValues(state, first.id)).toEqual({ size_label: '50-249' })
    const reverted = stagingReducer(state, { type: 'revertCell', id: first.id, column: 'size_label' })
    expect(isDirty(reverted)).toBe(false)
    expect(rowStatus(reverted, first.id)).toBeNull()
  })

  it('reverts one row or everything', () => {
    const state = run(
      { type: 'edit', row: first, column: 'display_name', value: 'Autre' },
      { type: 'edit', row: second, column: 'size_label', value: null },
    )

    expect(stagingReducer(state, { type: 'revert', id: first.id }).updates.map((item) => item.id)).toEqual([second.id])
    expect(stagingReducer(state, { type: 'clear' })).toEqual(EMPTY_STAGING)
  })
})

describe('new rows and deletions', () => {
  it('adds new rows first and edits their values', () => {
    const id = newRowId(EMPTY_STAGING)
    const state = run({ type: 'addRow' }, { type: 'editNew', id, column: 'display_name', value: 'Messagerie Démo SA' }, { type: 'addRow' })

    expect(state.inserts.map((item) => item.id)).toEqual(['new-2', 'new-1'])
    expect(state.inserts[1]?.values).toEqual({ display_name: 'Messagerie Démo SA' })
    expect(rowStatus(state, id)).toBe('new')
    expect(summarize(state).inserts).toBe(2)
  })

  it('drops the pending edits of a deleted row and ignores later edits of it', () => {
    const state = run(
      { type: 'edit', row: first, column: 'display_name', value: 'Autre' },
      { type: 'delete', rows: [first, first] },
      { type: 'edit', row: first, column: 'size_label', value: 'x' },
    )

    expect(state.updates).toEqual([])
    expect(state.deletes.map((item) => item.id)).toEqual([first.id])
    expect(rowStatus(state, first.id)).toBe('deleted')
    expect(rowStatus(stagingReducer(state, { type: 'revert', id: first.id }), first.id)).toBeNull()
  })
})

describe('change set and server errors', () => {
  it('builds the request with the positions of every entry', () => {
    const state = run(
      { type: 'edit', row: second, column: 'size_label', value: null },
      { type: 'addRow' },
      { type: 'editNew', id: 'new-1', column: 'display_name', value: 'A' },
      { type: 'addRow' },
      { type: 'delete', rows: [first] },
    )

    const request = toChangeSet(state)

    expect(request.changes).toEqual({
      updates: [{ key: { id: COMPANY_IDS[1] }, version: '2026-09-02T09:30:00Z', values: { size_label: null } }],
      inserts: [{ values: { display_name: 'A' } }, { values: {} }],
      deletes: [{ key: { id: COMPANY_IDS[0] }, version: '2026-09-01T09:30:00Z' }],
    })
    expect(request.ids).toEqual({ update: [second.id], insert: ['new-1', 'new-2'], delete: [first.id] })
  })

  it('puts server errors back on their entries and clears an error when its cell is edited again', () => {
    const state = run({ type: 'edit', row: second, column: 'display_name', value: '' }, { type: 'addRow' })
    const { ids } = toChangeSet(state)
    const errors = errorsById(ids, [
      { operation: 'update', index: 0, column: 'display_name', code: 'check_violation', message: 'Le nom ne peut pas être vide.' },
      { operation: 'insert', index: 0, column: 'display_name', code: 'required', message: 'Valeur obligatoire.' },
      { operation: 'delete', index: 3, column: null, code: 'not_found', message: 'ignored' },
    ])
    const refused = stagingReducer(state, { type: 'setErrors', errors })

    expect(errorCount(refused)).toBe(2)
    expect(refused.errors[second.id]).toEqual([{ column: 'display_name', message: 'Le nom ne peut pas être vide.' }])
    const fixed = stagingReducer(refused, { type: 'edit', row: second, column: 'display_name', value: 'Logistique SAS' })
    expect(fixed.errors[second.id]).toBeUndefined()
    expect(errorCount(fixed)).toBe(1)
  })
})
