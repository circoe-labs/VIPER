import { describe, expect, it } from 'vitest'

import { DEFAULT_VIEW, hasFilters, parseView, prospectionHref, serializeView } from './criteria'

const ID = '0192f0aa-0000-7000-8000-000000000042'

describe('Prospection URL state', () => {
  it('round-trips every criterion and omits defaults', () => {
    const view = {
      ...DEFAULT_VIEW,
      segment: 'due' as const,
      q: 'jean exemple',
      role: 'none',
      activity: 'active' as const,
      referent: ID,
      tracking_status: 'disqualified' as const,
      cohort: ID,
      company: ID,
      import_batch: ID,
      sort: 'next_due' as const,
      page: 3,
      prospect: ID,
    }

    expect(parseView(serializeView(view))).toEqual(view)
    expect(serializeView(DEFAULT_VIEW).toString()).toBe('')
    expect(serializeView({ segment: 'due', page: 1 }).toString()).toBe('segment=due')
  })

  it('drops malformed or unknown values instead of failing', () => {
    const view = parseView(
      new URLSearchParams(
        'segment=vip&activity=retired&role=12&company=none&tracking_status=do_not_contact&sort=x&page=-2&prospect=abc',
      ),
    )

    expect(view).toEqual(DEFAULT_VIEW)
  })

  it('accepts « none » only where it means no value, and `new` for the prospect', () => {
    const view = parseView(new URLSearchParams('role=none&referent=none&tracking_status=none&cohort=none&prospect=new'))

    expect([view.role, view.referent, view.tracking_status, view.cohort, view.prospect]).toEqual([
      'none',
      'none',
      'none',
      'none',
      'new',
    ])
  })

  it('drops the former states and reads a former « planned_contact » sort as the next due date', () => {
    const view = parseView(new URLSearchParams('tracking_status=contacted&sort=planned_contact'))

    expect([view.tracking_status, view.sort]).toEqual([null, 'next_due'])
  })

  it('builds deep links for other pages (Home)', () => {
    expect(prospectionHref()).toBe('/prospection')
    expect(prospectionHref({ segment: 'no_response' })).toBe('/prospection?segment=no_response')
  })

  it('tells criteria other than the segment and the sort', () => {
    expect(hasFilters({ ...DEFAULT_VIEW, segment: 'due', sort: 'company' })).toBe(false)
    expect(hasFilters({ ...DEFAULT_VIEW, q: '  ' })).toBe(false)
    expect(hasFilters({ ...DEFAULT_VIEW, q: 'jean' })).toBe(true)
    expect(hasFilters({ ...DEFAULT_VIEW, import_batch: ID })).toBe(true)
    expect(hasFilters({ ...DEFAULT_VIEW, cohort: 'none' })).toBe(true)
  })
})
