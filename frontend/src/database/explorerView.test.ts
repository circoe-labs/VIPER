import { describe, expect, it } from 'vitest'

import { EMPTY_VIEW, type ExplorerView, nextSort, parseView, serializeView, toRowsQuery, viewHref } from './explorerView'

describe('URL view state', () => {
  it('round-trips search, sort, filters and paging, omitting defaults', () => {
    const view: ExplorerView = {
      search: 'fret',
      sort: [
        { column: 'size_label', desc: false },
        { column: 'display_name', desc: true },
      ],
      filters: [
        { column: 'display_name', operator: 'contains', value: 'Exemple' },
        { column: 'rows_total', operator: 'in', values: [1, 2] },
        { column: 'legal_name', operator: 'is_null' },
      ],
      page: 3,
      pageSize: 250,
    }

    const params = serializeView(view)
    expect(params.get('sort')).toBe('size_label,-display_name')
    expect(parseView(params)).toEqual(view)
    expect(serializeView(EMPTY_VIEW).toString()).toBe('')
  })

  it('drops malformed values instead of failing', () => {
    const params = new URLSearchParams({
      filters: '[{"column":"a","operator":"eq","value":"x"},{"column":"b","operator":"DROP"},{"operator":"eq"},"x"]',
      page: '-2',
      size: '42',
      sort: ',-,name',
    })

    expect(parseView(params)).toEqual({
      ...EMPTY_VIEW,
      sort: [{ column: 'name', desc: false }],
      filters: [{ column: 'a', operator: 'eq', value: 'x' }],
    })
    expect(parseView(new URLSearchParams({ filters: '{oops' })).filters).toEqual([])
  })

  it('builds explorer links', () => {
    expect(viewHref('companies')).toBe('/database/companies')
    expect(viewHref('companies', { filters: [{ column: 'id', operator: 'eq', value: 'x' }] })).toBe(
      `/database/companies?filters=${encodeURIComponent('[{"column":"id","operator":"eq","value":"x"}]')}`,
    )
  })
})

describe('nextSort', () => {
  it('cycles a single column: ascending, descending, unsorted', () => {
    const asc = nextSort([], 'name', false)
    const desc = nextSort(asc, 'name', false)

    expect(asc).toEqual([{ column: 'name', desc: false }])
    expect(desc).toEqual([{ column: 'name', desc: true }])
    expect(nextSort(desc, 'name', false)).toEqual([])
    expect(nextSort(desc, 'other', false)).toEqual([{ column: 'other', desc: false }])
  })

  it('builds a multi-column sort with Shift and keeps priorities', () => {
    const two = nextSort(nextSort([], 'a', true), 'b', true)
    expect(two).toEqual([
      { column: 'a', desc: false },
      { column: 'b', desc: false },
    ])
    expect(nextSort(two, 'a', true)).toEqual([
      { column: 'a', desc: true },
      { column: 'b', desc: false },
    ])
    expect(nextSort(nextSort(two, 'a', true), 'a', true)).toEqual([{ column: 'b', desc: false }])
  })
})

describe('toRowsQuery', () => {
  it('turns the view into the API filter AST, sort keys and offset', () => {
    const query = toRowsQuery({
      search: '  exemple ',
      sort: [{ column: 'name', desc: true }],
      filters: [{ column: 'name', operator: 'contains', value: 'x' }],
      page: 3,
      pageSize: 50,
    })

    expect(query).toEqual({
      filter: {
        type: 'group',
        combinator: 'and',
        conditions: [{ type: 'condition', column: 'name', operator: 'contains', value: 'x' }],
      },
      search: 'exemple',
      sort: ['-name'],
      offset: 100,
      limit: 50,
    })
    expect(toRowsQuery(EMPTY_VIEW).filter).toBeNull()
  })
})
