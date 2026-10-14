import { describe, expect, it } from 'vitest'

import type { ScoreContribution } from '../api/prospects'
import { contributionSource, signedDelta, sortContributions } from './scoreView'

function line(id: string, delta: number, fields: Partial<ScoreContribution> = {}): ScoreContribution {
  return { id, delta, reason: id, source_type: null, source_ref: null, created_at: null, origin: 'manual', ...fields }
}

describe('sortContributions', () => {
  it('lists the positives from the largest, then the negatives from the most damaging, ties in the API order', () => {
    const sorted = sortContributions([line('a', -5), line('b', 3), line('c', -20), line('d', 10), line('e', 3), line('f', 0)])

    expect(sorted.map((item) => item.id)).toEqual(['d', 'b', 'e', 'f', 'c', 'a'])
  })

  it('does not change the list it is given', () => {
    const input = [line('a', -1), line('b', 1)]
    sortContributions(input)
    expect(input.map((item) => item.id)).toEqual(['a', 'b'])
  })
})

describe('signedDelta and contributionSource', () => {
  it('writes the sign', () => {
    expect([signedDelta(5), signedDelta(-10), signedDelta(0)]).toEqual(['+5', '-10', '0'])
  })

  it('names the source in words', () => {
    expect(contributionSource(line('a', 1, { source_type: 'note', source_ref: 'n1' }))).toBe('Note du prospect')
    expect(contributionSource(line('a', 1, { source_type: 'rule' }))).toBe('Source : rule')
    expect(contributionSource(line('a', 1))).toBe('Source non précisée')
  })
})
