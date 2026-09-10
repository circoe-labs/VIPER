import { describe, expect, it } from 'vitest'

import { column, companiesTable, idColumn, prospectsTable } from '../test/explorerFixtures'
import { clipboardValue, compactUuid, displayValue, fullValueText, rowToJson, rowToTsv } from './cells'
import { buildFilter, describeFilter, filterForValue, operatorLabel } from './filters'

const integer = companiesTable.columns[4] ?? column('rows_total')
const status = prospectsTable.columns[3] ?? column('activity_status')
const json = prospectsTable.columns[4] ?? column('legacy_metadata')
const datetime = column('created_at', { kind: 'datetime', sql_type: 'timestamp with time zone', filter_operators: ['gt', 'lt', 'is_null'] })
const boolean = column('is_primary', { kind: 'boolean', filter_operators: ['eq', 'neq', 'is_null', 'not_null'] })

describe('buildFilter', () => {
  it('parses values by column kind', () => {
    expect(buildFilter(integer, 'gte', ' 42 ')).toEqual({ ok: true, filter: { column: 'rows_total', operator: 'gte', value: 42 } })
    expect(buildFilter(integer, 'eq', '4.5')).toEqual({ ok: false, error: 'Nombre entier attendu.' })
    expect(buildFilter(boolean, 'eq', 'false')).toEqual({ ok: true, filter: { column: 'is_primary', operator: 'eq', value: false } })
    expect(buildFilter(status, 'eq', 'retired')).toEqual({ ok: false, error: 'Choisissez une valeur autorisée.' })
    expect(buildFilter(idColumn, 'eq', 'nope')).toMatchObject({ ok: false })
    expect(buildFilter(idColumn, 'starts_with', '01a0')).toMatchObject({ ok: true })
    expect(buildFilter(idColumn, 'starts_with', "01a'")).toMatchObject({ ok: false })
    expect(buildFilter(column('display_name'), 'contains', '  ')).toEqual({ ok: false, error: 'Saisissez une valeur.' })
  })

  it('sends datetimes as absolute ISO instants', () => {
    const result = buildFilter(datetime, 'gt', '2026-03-01T12:30')

    expect(result).toEqual({
      ok: true,
      filter: { column: 'created_at', operator: 'gt', value: new Date('2026-03-01T12:30').toISOString() },
    })
  })

  it('needs no value for NULL checks and a list for `in`', () => {
    expect(buildFilter(column('legal_name'), 'is_null', '')).toEqual({ ok: true, filter: { column: 'legal_name', operator: 'is_null' } })
    expect(buildFilter(integer, 'in', '1, 2\n3')).toEqual({ ok: true, filter: { column: 'rows_total', operator: 'in', values: [1, 2, 3] } })
    expect(buildFilter(integer, 'in', '1, deux')).toEqual({ ok: false, error: '« deux » : Nombre entier attendu.' })
    expect(buildFilter(integer, 'in', ' , ')).toEqual({ ok: false, error: 'Saisissez au moins une valeur.' })
  })
})

describe('filter labels', () => {
  it('describes filters in French, with date wording for timestamps', () => {
    expect(describeFilter({ column: 'display_name', operator: 'contains', value: 'fret' }, column('display_name'))).toBe(
      'display_name contient « fret »',
    )
    expect(describeFilter({ column: 'rows_total', operator: 'in', values: [1, 2] }, integer)).toBe(
      'rows_total fait partie de « 1 », « 2 »',
    )
    expect(describeFilter({ column: 'legal_name', operator: 'is_null' }, undefined)).toBe('legal_name est vide (NULL)')
    expect(operatorLabel('gt', datetime)).toBe('après le')
    expect(operatorLabel('gt', integer)).toBe('est supérieur à')
  })
})

describe('filterForValue', () => {
  it('filters or excludes the exact value, or NULL', () => {
    expect(filterForValue(column('size_label'), '10-49')).toEqual({ column: 'size_label', operator: 'eq', value: '10-49' })
    expect(filterForValue(column('size_label'), '10-49', true)).toEqual({ column: 'size_label', operator: 'neq', value: '10-49' })
    expect(filterForValue(column('size_label'), null)).toEqual({ column: 'size_label', operator: 'is_null' })
    expect(filterForValue(column('size_label'), null, true)).toEqual({ column: 'size_label', operator: 'not_null' })
  })

  it('gives nothing for values without equality or masked columns', () => {
    expect(filterForValue(json, { a: 1 })).toBeNull()
    expect(filterForValue(column('secret', { masked: true, filter_operators: [] }), 'x')).toBeNull()
  })
})

describe('cell values', () => {
  it('formats values for the grid, the clipboard and the viewer', () => {
    expect(displayValue(null, 'text')).toBe('NULL')
    expect(displayValue(true, 'boolean')).toBe('true')
    expect(displayValue(['a', 'b'], 'array')).toBe('["a","b"]')
    expect(displayValue('2026-03-01T12:30:05Z', 'datetime')).toMatch(/^2026-03-0[12] \d{2}:30:05$/)
    expect(clipboardValue('2026-03-01T12:30:05Z')).toBe('2026-03-01T12:30:05Z')
    expect(clipboardValue(null)).toBe('')
    expect(fullValueText({ a: [1] }, 'json')).toBe('{\n  "a": [\n    1\n  ]\n}')
    expect(fullValueText('{"a":1}', 'json')).toBe('{\n  "a": 1\n}')
    expect(fullValueText('{cut', 'json')).toBe('{cut')
    expect(compactUuid('01a00000-0000-7000-8000-000000000001')).toBe('01a00000…00000001')
  })

  it('copies rows as one TSV line or as JSON, in display order', () => {
    const values = { id: 'x', name: 'Tab\there\nnewline', count: 3, missing: null }

    expect(rowToTsv(values, ['name', 'id', 'count', 'missing'])).toBe('Tab here newline\tx\t3\t')
    expect(JSON.parse(rowToJson(values, ['count', 'missing']))).toEqual({ count: 3, missing: null })
  })
})
