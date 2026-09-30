import { describe, expect, it } from 'vitest'

import { DEFAULT_VIEW, hasFilters, listCriteria, parseView, selectCounter, serializeView } from './criteria'

const ID = '0192aaaa-0000-7000-8000-000000000001'

describe('Contact criteria', () => {
  it('reads the URL, dropping anything malformed', () => {
    expect(parseView(new URLSearchParams(''))).toEqual(DEFAULT_VIEW)
    expect(
      parseView(new URLSearchParams(`counter=follow_up&week=2026-W41&state=r1&q=fret&page=2&prospect=${ID}`)),
    ).toEqual({ counter: 'follow_up', week: '2026-W41', state: 'r1', q: 'fret', page: 2, prospect: ID })
    expect(parseView(new URLSearchParams('counter=nope&week=41&state=ignored&page=-1&prospect=new'))).toEqual(DEFAULT_VIEW)
    expect(parseView(new URLSearchParams('week=all')).week).toBe('all')
  })

  it('writes only what differs from the defaults', () => {
    expect(serializeView(DEFAULT_VIEW).toString()).toBe('')
    expect(serializeView({ week: 'all', counter: 'appointments', prospect: ID }).toString()).toBe(
      `counter=appointments&week=all&prospect=${ID}`,
    )
  })

  it('sends « cette semaine » as the server’s current week, and nothing until it is known', () => {
    expect(listCriteria(DEFAULT_VIEW, undefined)).toBeNull()
    expect(listCriteria(DEFAULT_VIEW, '2026-W40')).toEqual({ counter: null, week: '2026-W40', state: null, q: '' })
    expect(listCriteria({ ...DEFAULT_VIEW, week: 'all', q: ' fret ' }, undefined)).toEqual({
      counter: null,
      week: null,
      state: null,
      q: 'fret',
    })
    expect(listCriteria({ ...DEFAULT_VIEW, week: '2026-W42' }, '2026-W40')?.week).toBe('2026-W42')
  })

  it('opens a counter on every week (the card equals its list), and closes it back to this week', () => {
    expect(selectCounter({ ...DEFAULT_VIEW, state: 'r1' }, 'to_handle')).toEqual({ counter: 'to_handle', week: 'all', state: null, page: 1 })
    expect(selectCounter({ ...DEFAULT_VIEW, counter: 'to_handle', week: 'all' }, 'to_handle')).toEqual({
      counter: null,
      week: 'current',
      page: 1,
    })
  })

  it('counts every narrowing criterion as a filter', () => {
    expect(hasFilters(DEFAULT_VIEW)).toBe(false)
    expect(hasFilters({ ...DEFAULT_VIEW, week: 'all' })).toBe(true)
    expect(hasFilters({ ...DEFAULT_VIEW, state: 'r2' })).toBe(true)
    expect(hasFilters({ ...DEFAULT_VIEW, q: 'x' })).toBe(true)
  })
})
