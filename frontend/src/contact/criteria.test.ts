import { describe, expect, it } from 'vitest'

import { DEFAULT_VIEW, listCriteria, parseView, serializeView } from './criteria'

const ID = '0192aaaa-0000-7000-8000-000000000001'

describe('Contact criteria', () => {
  it('reads the URL, dropping anything malformed', () => {
    expect(parseView(new URLSearchParams(''))).toEqual(DEFAULT_VIEW)
    expect(parseView(new URLSearchParams(`section=contactes&q=fret&prospect=${ID}`))).toEqual({ ...DEFAULT_VIEW, section: 'CONTACTES', q: 'fret', prospect: ID })
    expect(parseView(new URLSearchParams(`section=S40&prospect=${ID}`))).toEqual({ ...DEFAULT_VIEW, prospect: ID })
    expect(parseView(new URLSearchParams('cohort=S38&prospect=new'))).toEqual(DEFAULT_VIEW)
  })

  it('writes only what differs from the defaults', () => {
    expect(serializeView(DEFAULT_VIEW).toString()).toBe('')
    expect(serializeView({ section: 'CONTACTES', prospect: ID }).toString()).toBe(`section=CONTACTES&prospect=${ID}`)
  })

  it('lists one section under the trimmed search', () => {
    expect(listCriteria({ ...DEFAULT_VIEW, q: ' fret ' }, 'CONTACTES')).toEqual({ section: 'CONTACTES', q: 'fret', status: null, company: null })
    expect(listCriteria({ ...DEFAULT_VIEW, section: 'CONTACTES' })).toEqual({ section: 'CONTACTES', q: '', status: null, company: null })
  })
})
