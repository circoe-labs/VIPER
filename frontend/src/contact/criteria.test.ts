import { describe, expect, it } from 'vitest'

import { DEFAULT_VIEW, listCriteria, parseView, serializeView } from './criteria'

const ID = '0192aaaa-0000-7000-8000-000000000001'

describe('Contact criteria', () => {
  it('reads the URL, dropping anything malformed', () => {
    expect(parseView(new URLSearchParams(''))).toEqual(DEFAULT_VIEW)
    expect(parseView(new URLSearchParams(`section=s40&q=fret&prospect=${ID}`))).toEqual({ section: 'S40', q: 'fret', prospect: ID })
    expect(parseView(new URLSearchParams('cohort=S38&prospect=new'))).toEqual(DEFAULT_VIEW)
  })

  it('writes only what differs from the defaults', () => {
    expect(serializeView(DEFAULT_VIEW).toString()).toBe('')
    expect(serializeView({ section: 'S41', prospect: ID }).toString()).toBe(`section=S41&prospect=${ID}`)
  })

  it('lists one section under the trimmed search', () => {
    expect(listCriteria({ ...DEFAULT_VIEW, q: ' fret ' }, 'S39')).toEqual({ section: 'S39', q: 'fret' })
    expect(listCriteria({ ...DEFAULT_VIEW, section: 'S43' })).toEqual({ section: 'S43', q: '' })
  })
})
