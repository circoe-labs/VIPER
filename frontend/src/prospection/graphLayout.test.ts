import { describe, expect, it } from 'vitest'

import type { LinkGraph, Person } from '../api/links'
import { hueIndex, initials, layoutGraph } from './graphLayout'

const person = (id: string, name: string, company: string | null): Person => ({
  kind: 'prospect',
  id,
  name,
  company_id: company,
  company_name: company,
})

const GRAPH: LinkGraph = {
  members: [{ kind: 'member', id: 'robin', name: 'Robin Pote', company_id: null, company_name: null }],
  companies: [
    { id: 'a', name: 'Acme', prospects: [person('1', 'Anne Martin', 'a'), person('2', 'Paul Durand', 'a')] },
    { id: 'b', name: 'Bravo', prospects: [person('3', 'Léa Petit', 'b')] },
  ],
  links: [],
}

describe('layoutGraph', () => {
  it('gives every person a place and keeps the blobs apart', () => {
    const layout = layoutGraph(GRAPH)

    expect([...layout.nodes.keys()].sort()).toEqual(['member:robin', 'prospect:1', 'prospect:2', 'prospect:3'])
    for (const [index, blob] of layout.blobs.entries()) {
      for (const other of layout.blobs.slice(index + 1)) {
        expect(Math.hypot(blob.x - other.x, blob.y - other.y)).toBeGreaterThanOrEqual(blob.radius + other.radius)
      }
    }
  })

  it('is deterministic', () => {
    expect(layoutGraph(GRAPH).bounds).toEqual(layoutGraph(GRAPH).bounds)
  })

  it('handles an empty graph', () => {
    expect(layoutGraph({ members: [], companies: [], links: [] }).blobs).toEqual([])
  })
})

describe('avatars', () => {
  it('uses the initials and a stable hue', () => {
    expect(initials('Anne Martin')).toBe('AM')
    expect(initials('Prince')).toBe('PR')
    expect(hueIndex('Anne Martin')).toBe(hueIndex('Anne Martin'))
    expect(hueIndex('Anne Martin')).toBeLessThan(12)
  })
})
