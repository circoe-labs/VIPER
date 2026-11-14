import { describe, expect, it } from 'vitest'

import { DEFAULT_VIEW, entityHref, hasEntityFilters, hasFilters, parseView, prospectionHref, serializeView } from './criteria'

const ID = '0192f0aa-0000-7000-8000-000000000042'

describe('Prospection URL state', () => {
  it('round-trips every criterion and omits defaults', () => {
    const view = {
      ...DEFAULT_VIEW,
      validated_only: true,
      services: ['iguard', 'iadvice'].sort(),
      send_stage: 'r1' as const,
      company_kind: 'sme' as const,
      created_from: '2026-10-26',
      created_to: '2026-11-01',
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
    expect(hasFilters({ ...DEFAULT_VIEW, created_from: '2026-10-26' })).toBe(true)
  })

  it('serializes the entity selector and its filters; prospect is the omitted default; garbage falls back', () => {
    expect(entityHref('prospect')).toBe('/prospection')
    expect(entityHref('company')).toBe('/prospection?entity=company')
    const view = parseView(new URLSearchParams('entity=warehouse&warehouse_category=sme&warehouse_to_contact=true&q=x&page=2'))
    expect(view).toMatchObject({ entity: 'warehouse', warehouse_category: 'sme', warehouse_to_contact: true, q: 'x', page: 2 })
    expect(serializeView(view).toString()).toBe('entity=warehouse&warehouse_category=sme&warehouse_to_contact=true&q=x&page=2')
    expect(hasEntityFilters(view)).toBe(true)
    expect(hasEntityFilters({ ...DEFAULT_VIEW, entity: 'company' })).toBe(false)
    expect(parseView(new URLSearchParams('entity=nope&warehouse_category=nope'))).toMatchObject({ entity: 'prospect', warehouse_category: null })
  })
})
