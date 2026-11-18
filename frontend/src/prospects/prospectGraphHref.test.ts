import { describe, expect, it } from 'vitest'

import { prospectGraphHref } from './prospectGraphHref'

describe('prospectGraphHref', () => {
  it('targets the graph page, focused on the prospect node key', () => {
    const url = new URL(prospectGraphHref('abc-1'), 'http://x')
    expect(url.pathname).toBe('/prospection/graphe')
    expect(url.searchParams.get('focus')).toBe('prospect:abc-1')
  })
})
