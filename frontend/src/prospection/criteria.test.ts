import { describe, expect, it } from 'vitest'

import { clearedFilters, DEFAULT_VIEW, entityHref, hasEntityFilters, hasFilters, parseView, prospectionHref, serializeView, sortFor, switchEntity } from './criteria'

const ID = '0192f0aa-0000-7000-8000-000000000042'

describe('Prospection URL state', () => {
  it('round-trips every criterion and omits defaults', () => {
    const view = {
      ...DEFAULT_VIEW,
      validated_only: true,
      services: ['iguard', 'iadvice'].sort(),
      send_stage: ['sent' as const, 'r1' as const],
      email_state: ['verified' as const],
      company_kind: ['sme' as const, 'large' as const],
      commercial_segment: [ID, 'none'],
      activity_category: [ID],
      department: ['59', '971'],
      verification_box: ['todo' as const],
      created_from: '2026-10-26',
      created_to: '2026-11-01',
      segment: 'due' as const,
      q: 'jean exemple',
      role: [ID, 'none'],
      activity: ['active' as const, 'inactive' as const],
      referent: [ID],
      tracking_status: ['response_received' as const, 'disqualified' as const],
      cohort: [ID],
      company: [ID],
      import_batch: [ID],
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
      ['none'],
      ['none'],
      ['none'],
      ['none'],
      'new',
    ])
  })

  it('reads several values per filter, and a former single-value link as a selection of one', () => {
    const other = '0192f0aa-0000-7000-8000-000000000041'
    const view = parseView(new URLSearchParams(`role=${ID}&role=${other}&role=${ID}&role=junk&activity=inactive&activity=active&company_kind=sme`))
    expect(view.role).toEqual([other, ID])
    expect(view.activity).toEqual(['active', 'inactive'])
    expect(view.company_kind).toEqual(['sme'])
    expect(serializeView(view).getAll('role')).toEqual([other, ID])
  })

  it('drops the former states and reads a former « planned_contact » sort as the next due date', () => {
    const view = parseView(new URLSearchParams('tracking_status=contacted&sort=planned_contact'))

    expect([view.tracking_status, view.sort]).toEqual([[], 'next_due'])
  })

  it('builds deep links for other pages (Home)', () => {
    expect(prospectionHref()).toBe('/prospection')
    expect(prospectionHref({ segment: 'no_response' })).toBe('/prospection?segment=no_response')
  })

  it('tells criteria other than the segment and the sort', () => {
    expect(hasFilters({ ...DEFAULT_VIEW, segment: 'due', sort: 'company' })).toBe(false)
    expect(hasFilters({ ...DEFAULT_VIEW, q: '  ' })).toBe(false)
    expect(hasFilters({ ...DEFAULT_VIEW, q: 'jean' })).toBe(true)
    expect(hasFilters({ ...DEFAULT_VIEW, import_batch: [ID] })).toBe(true)
    expect(hasFilters({ ...DEFAULT_VIEW, cohort: ['none'] })).toBe(true)
    expect(hasFilters({ ...DEFAULT_VIEW, created_from: '2026-10-26' })).toBe(true)
  })

  it('serializes the entity selector and its filters; prospect is the omitted default; garbage falls back', () => {
    expect(entityHref(DEFAULT_VIEW, 'prospect')).toBe('/prospection')
    expect(entityHref(DEFAULT_VIEW, 'company')).toBe('/prospection?entity=company')
    const view = parseView(new URLSearchParams('entity=warehouse&warehouse_category=sme&warehouse_to_contact=true&q=x&page=2'))
    expect(view).toMatchObject({ entity: 'warehouse', warehouse_category: ['sme'], warehouse_to_contact: true, q: 'x', page: 2 })
    expect(serializeView(view).toString()).toBe('entity=warehouse&warehouse_category=sme&warehouse_to_contact=true&q=x&page=2')
    expect(hasEntityFilters(view)).toBe(true)
    expect(hasEntityFilters({ ...DEFAULT_VIEW, entity: 'company' })).toBe(false)
    expect(parseView(new URLSearchParams('entity=nope&warehouse_category=nope'))).toMatchObject({ entity: 'prospect', warehouse_category: [] })
  })

  it('switching entity keeps q and the shared filters only; sort created is kept by every entity', () => {
    const view = parseView(new URLSearchParams('validated_only=true&q=abc&created_from=2026-11-02&company_kind=sme&sort=created&role=none'))
    expect(serializeView(switchEntity(view, 'company')).toString()).toBe('entity=company&created_from=2026-11-02&company_kind=sme&q=abc&sort=created')
    expect(serializeView(switchEntity(view, 'warehouse')).toString()).toBe('entity=warehouse&created_from=2026-11-02&q=abc&sort=created')
    expect(sortFor({ entity: 'prospect', sort: 'created' })).toBe('created')
    expect(sortFor({ entity: 'company', sort: 'created' })).toBe('created')
    expect(serializeView(clearedFilters('prospect')).toString()).toBe('')
  })
})
