import { describe, expect, it } from 'vitest'

import { diffLines, MAX_LINES, pairChanges } from './textDiff'

describe('diffLines', () => {
  it('marks identical texts as unchanged', () => {
    const rows = diffLines('a\nb', 'a\nb')
    expect(rows?.map((row) => row.kind)).toEqual(['same', 'same'])
  })

  it('finds an added and a removed line', () => {
    const rows = diffLines('Bonjour\nancien\nMerci', 'Bonjour\nnouveau\nMerci')
    expect(rows?.map((row) => [row.kind, row.before, row.after])).toEqual([
      ['same', 'Bonjour', 'Bonjour'],
      ['added', null, 'nouveau'],
      ['removed', 'ancien', null],
      ['same', 'Merci', 'Merci'],
    ])
  })

  it('pairs a reworded line on one row', () => {
    const rows = pairChanges(diffLines('a\nancien\nz', 'a\nnouveau\nz') ?? [])
    expect(rows.map((row) => [row.before, row.after])).toEqual([
      ['a', 'a'],
      ['ancien', 'nouveau'],
      ['z', 'z'],
    ])
  })

  it('leaves a pure insertion or deletion without a partner', () => {
    const rows = pairChanges(diffLines('a\nb', 'a\nx\nb') ?? [])
    expect(rows.map((row) => [row.kind, row.before, row.after])).toEqual([
      ['same', 'a', 'a'],
      ['added', null, 'x'],
      ['same', 'b', 'b'],
    ])
  })

  it('gives up on a text too long to compare', () => {
    expect(diffLines('x\n'.repeat(MAX_LINES + 1), 'y')).toBeNull()
  })
})
