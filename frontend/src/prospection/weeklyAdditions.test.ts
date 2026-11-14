import { describe, expect, it } from 'vitest'

import { weeklyAdditionsFrom } from './weeklyAdditions'

describe('weekly additions adapter', () => {
  it('maps the weekly metrics additions per entity, with no per-status delta', () => {
    const weekly = weeklyAdditionsFrom({ additions: { prospects: 4, companies: 0, warehouses: 2 } })
    expect(weekly).toEqual({ added: { prospect: 4, company: 0, warehouse: 2 }, byStatus: {}, state: 'ready' })
  })
  it('reports unavailable rather than zero when the source lacks the figure', () => {
    expect(weeklyAdditionsFrom(undefined).state).toBe('unavailable')
    expect(weeklyAdditionsFrom({ additions: undefined as never }).added).toEqual({ prospect: null, company: null, warehouse: null })
    const partial = weeklyAdditionsFrom({ additions: { prospects: 3 } as never })
    expect(partial.added).toEqual({ prospect: 3, company: null, warehouse: null })
  })
})
