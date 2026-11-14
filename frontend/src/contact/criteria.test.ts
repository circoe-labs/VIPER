import { describe, expect, it } from 'vitest'

import { DEFAULT_VIEW, listCriteria, parseView, serializeView } from './criteria'

const ID = '0192aaaa-0000-7000-8000-000000000001'

describe('Contact criteria', () => {
  it('reads the URL, dropping anything malformed', () => {
    expect(parseView(new URLSearchParams(''))).toEqual(DEFAULT_VIEW)
    expect(parseView(new URLSearchParams(`view=follow_ups&q=fret&prospect=${ID}`))).toEqual({ ...DEFAULT_VIEW, view: 'follow_ups', q: 'fret', prospect: ID })
    expect(parseView(new URLSearchParams('view=to_contact&week=2026-W42'))).toEqual({ ...DEFAULT_VIEW, view: 'to_contact', week: '2026-W42' })
    expect(parseView(new URLSearchParams('view=nope&week=next'))).toEqual(DEFAULT_VIEW)
    expect(parseView(new URLSearchParams(`section=S40&prospect=${ID}`))).toEqual({ ...DEFAULT_VIEW, prospect: ID })
    expect(parseView(new URLSearchParams('cohort=S38&prospect=new'))).toEqual(DEFAULT_VIEW)
  })

  it('keeps the former contacted-section bookmarks working', () => {
    expect(parseView(new URLSearchParams(`section=contactes&q=fret&prospect=${ID}`))).toEqual({ ...DEFAULT_VIEW, view: 'contacted', q: 'fret', prospect: ID })
    expect(parseView(new URLSearchParams('view=responses&section=CONTACTES')).view).toBe('responses')
  })

  it('writes only what differs from the defaults', () => {
    expect(serializeView(DEFAULT_VIEW).toString()).toBe('')
    expect(serializeView({ view: 'contacted', prospect: ID }).toString()).toBe(`view=contacted&prospect=${ID}`)
    expect(serializeView({ view: 'to_contact', week: '2026-W42' }).toString()).toBe('view=to_contact&week=2026-W42')
  })

  it('lists under the trimmed search, whatever the view', () => {
    expect(listCriteria({ ...DEFAULT_VIEW, q: ' fret ', view: 'contacted' })).toEqual({ section: 'CONTACTES', q: 'fret', status: null, company: null, validation: null })
    expect(listCriteria({ ...DEFAULT_VIEW, view: 'responses' })).toEqual({ section: null, q: '', status: null, company: null, validation: null })
  })
})
