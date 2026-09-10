import { describe, expect, it } from 'vitest'

import type { ProspectListCriteria, ProspectPage } from '../api/prospection'
import { prospect } from '../test/prospectionApi'
import { DEFAULT_VIEW } from './criteria'
import { createProspectQueue } from './queue'

const CRITERIA: ProspectListCriteria = { ...DEFAULT_VIEW, segment: 'never_verified' }
const SIZE = 3

// A list the tests change between reads, as saves do.
function server(ids: string[]) {
  const list = [...ids]
  const reads: number[] = []
  return {
    list,
    reads,
    fetchPage(page: number): Promise<ProspectPage> {
      reads.push(page)
      const offset = (page - 1) * SIZE
      const items = list.slice(offset, offset + SIZE).map((id) => ({ ...prospect('P', id), id }))
      return Promise.resolve({ items, total: list.length, limit: SIZE, offset })
    },
  }
}

async function queueOn(ids: string[], page = 1) {
  const backend = server(ids)
  const queue = createProspectQueue(CRITERIA, { page, data: await backend.fetchPage(page) }, (n) =>
    backend.fetchPage(n),
  )
  backend.reads.length = 0
  return { queue, backend }
}

describe('prospect queue', () => {
  it('walks the page in list order without reading the server', async () => {
    const { queue, backend } = await queueOn(['a', 'b', 'c', 'd'])

    expect(await queue.next('a')).toEqual({ id: 'b', page: 1 })
    expect(await queue.next('b')).toEqual({ id: 'c', page: 1 })
    expect(queue.position('b')).toBe(2)
    expect(backend.reads).toEqual([])
  })

  it('continues on the next page when nobody left the list', async () => {
    const { queue, backend } = await queueOn(['a', 'b', 'c', 'd', 'e'])

    expect(await queue.next('c')).toEqual({ id: 'd', page: 2 })
    expect(backend.reads).toEqual([1, 2])
    expect(queue.ids).toEqual(['d', 'e'])
    expect(queue.position('e')).toBe(5)
    expect(await queue.next('d')).toEqual({ id: 'e', page: 2 })
  })

  it('skips nobody when saved people left the segment (pages shift)', async () => {
    const { queue, backend } = await queueOn(['a', 'b', 'c', 'd', 'e', 'f', 'g'])
    // a, b and c were verified one after the other: they left « Jamais vérifiés ».
    backend.list.splice(0, 3)

    expect(await queue.next('c')).toEqual({ id: 'd', page: 1 })
    expect(await queue.next('d')).toEqual({ id: 'e', page: 1 })
  })

  it('handles a mix of people who stayed and who left', async () => {
    const { queue, backend } = await queueOn(['a', 'b', 'c', 'd', 'e', 'f', 'g'])
    backend.list.splice(1, 1) // b left, a and c stayed

    expect(await queue.next('c')).toEqual({ id: 'd', page: 1 })
  })

  it('ends after the last person', async () => {
    const { queue } = await queueOn(['a', 'b', 'c', 'd'], 2)

    expect(await queue.next('d')).toBeNull()
  })

  it('starts at the top of the page for a prospect it does not hold', async () => {
    const { queue } = await queueOn(['a', 'b'])

    expect(await queue.next('zz')).toEqual({ id: 'a', page: 1 })
    expect(queue.position('zz')).toBeNull()
  })
})
