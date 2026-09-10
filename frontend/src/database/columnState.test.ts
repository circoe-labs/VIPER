import { describe, expect, it } from 'vitest'

import { column, companiesTable } from '../test/explorerFixtures'
import {
  type ColumnAction,
  type ColumnState,
  columnStateReducer,
  defaultWidth,
  displayOrder,
  initialColumnState,
  loadColumnState,
  MAX_WIDTH,
  MIN_WIDTH,
  reconcile,
  saveColumnState,
} from './columnState'

const COLUMNS = companiesTable.columns
const initial = initialColumnState(COLUMNS)

function apply(state: ColumnState, ...actions: ColumnAction[]): ColumnState {
  return actions.reduce(columnStateReducer, state)
}

describe('initial column state', () => {
  it('keeps the schema order and pins the primary key', () => {
    expect(initial).toEqual({
      order: ['id', 'display_name', 'size_label', 'client_approach', 'rows_total'],
      hidden: [],
      pinned: ['id'],
      widths: {},
    })
  })

  it('sizes columns by kind and name length', () => {
    expect(defaultWidth(column('x', { kind: 'integer' }))).toBe(120)
    expect(defaultWidth(column('x', { kind: 'json' }))).toBe(280)
    expect(defaultWidth(column('a_very_long_column_name_indeed'))).toBeGreaterThan(220)
  })
})

describe('columnStateReducer', () => {
  it('hides and shows columns but never hides the last visible one', () => {
    const hidden = apply(initial, { type: 'toggle', column: 'size_label' })
    expect(displayOrder(hidden)).toEqual(['id', 'display_name', 'client_approach', 'rows_total'])
    expect(apply(hidden, { type: 'toggle', column: 'size_label' }).hidden).toEqual([])

    const allButOne = apply(
      initial,
      ...['display_name', 'size_label', 'client_approach', 'rows_total'].map((name): ColumnAction => ({ type: 'toggle', column: name })),
    )
    expect(apply(allButOne, { type: 'toggle', column: 'id' })).toBe(allButOne)
    expect(apply(allButOne, { type: 'showAll' }).hidden).toEqual([])
  })

  it('shows pinned columns first and moves columns within their group', () => {
    const pinned = apply(initial, { type: 'pin', column: 'size_label', pinned: true })
    expect(displayOrder(pinned)).toEqual(['id', 'size_label', 'display_name', 'client_approach', 'rows_total'])

    expect(displayOrder(apply(pinned, { type: 'move', column: 'size_label', offset: -1 }))).toEqual([
      'size_label',
      'id',
      'display_name',
      'client_approach',
      'rows_total',
    ])
    // Moving across the pinned / scrolling boundary is a no-op: pin or unpin instead.
    expect(apply(pinned, { type: 'move', column: 'size_label', offset: 1 })).toBe(pinned)
    expect(apply(pinned, { type: 'move', column: 'rows_total', offset: 1 })).toBe(pinned)
    expect(displayOrder(apply(pinned, { type: 'move', column: 'rows_total', offset: -1 })).slice(-2)).toEqual([
      'rows_total',
      'client_approach',
    ])
    expect(displayOrder(apply(pinned, { type: 'pin', column: 'size_label', pinned: false }))).toEqual(
      displayOrder(initial),
    )
  })

  it('reorders by drag target, including to the end', () => {
    expect(apply(initial, { type: 'reorder', column: 'rows_total', before: 'display_name' }).order).toEqual([
      'id',
      'rows_total',
      'display_name',
      'size_label',
      'client_approach',
    ])
    expect(apply(initial, { type: 'reorder', column: 'display_name', before: null }).order.at(-1)).toBe('display_name')
    expect(apply(initial, { type: 'reorder', column: 'display_name', before: 'unknown' })).toBe(initial)
  })

  it('clamps widths and resets one column to its default', () => {
    const resized = apply(initial, { type: 'resize', widths: { display_name: 5, size_label: 10_000, rows_total: 150.6 } })
    expect(resized.widths).toEqual({ display_name: MIN_WIDTH, size_label: MAX_WIDTH, rows_total: 151 })
    expect(apply(resized, { type: 'resetWidth', column: 'size_label' }).widths).toEqual({
      display_name: MIN_WIDTH,
      rows_total: 151,
    })
  })

  it('resets the whole layout', () => {
    const changed = apply(
      initial,
      { type: 'toggle', column: 'size_label' },
      { type: 'pin', column: 'id', pinned: false },
      { type: 'resize', widths: { id: 300 } },
    )
    expect(apply(changed, { type: 'reset', columns: COLUMNS })).toEqual(initial)
  })
})

describe('persistence', () => {
  it('round-trips the layout per table', () => {
    const changed = apply(initial, { type: 'toggle', column: 'size_label' }, { type: 'resize', widths: { id: 200 } })
    saveColumnState('companies', changed)

    expect(loadColumnState('companies', COLUMNS)).toEqual(changed)
    expect(loadColumnState('prospects', COLUMNS)).toEqual(initial)
  })

  it('reconciles a stored layout with the current columns', () => {
    const stored: ColumnState = {
      order: ['display_name', 'dropped', 'id'],
      hidden: ['dropped', 'size_label'],
      pinned: ['dropped'],
      widths: { dropped: 100, id: 5000 },
    }

    expect(reconcile(stored, COLUMNS)).toEqual({
      order: ['display_name', 'id', 'size_label', 'client_approach', 'rows_total'],
      hidden: ['size_label'],
      pinned: [],
      widths: { id: MAX_WIDTH },
    })
  })

  it('ignores corrupt or outdated entries', () => {
    for (const raw of ['{not json', '{"version":0,"order":[],"hidden":[],"pinned":[],"widths":{}}', '{"version":1,"order":"x"}']) {
      window.localStorage.setItem('viper.explorer.columns.companies', raw)
      expect(loadColumnState('companies', COLUMNS)).toEqual(initial)
    }
  })
})
