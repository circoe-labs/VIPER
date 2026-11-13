import { describe, expect, it } from 'vitest'

import { donutModel, donutSummary } from './donutModel'
import { categoryAccent, categoryIcon } from './categoryVisual'

const seg = (key: string, value: number) => ({ key, label: key.toUpperCase(), value, hue: 'blue' as const })

describe('donutModel', () => {
  it('computes shares and contiguous arcs', () => {
    const model = donutModel([seg('a', 1), seg('b', 3)])
    expect(model.total).toBe(4)
    expect(model.segments.map((s) => s.share)).toEqual([0.25, 0.75])
    expect(model.segments[1]?.start).toBe(25)
    expect(model.folded).toBe(false)
  })

  it('treats negative and non-finite figures as zero, and an all-zero chart as empty', () => {
    const model = donutModel([seg('a', -2), seg('b', Number.NaN)])
    expect(model.total).toBe(0)
    expect(model.segments.every((s) => s.share === 0)).toBe(true)
    expect(donutSummary('Appels', model, 'appels')).toBe('Appels : aucune donnée.')
  })

  it('folds the tail beyond six categories into Autres', () => {
    const model = donutModel([1, 2, 3, 4, 5, 6, 7].map((n) => seg(`k${String(n)}`, n)))
    expect(model.segments).toHaveLength(6)
    expect(model.folded).toBe(true)
    expect(model.segments.at(-1)).toMatchObject({ key: 'other', label: 'Autres', value: 3 })
    expect(model.total).toBe(28)
  })

  it('states every category, its share and the total in the text alternative', () => {
    const text = donutSummary('Tâches', donutModel([seg('a', 1), seg('b', 1)]), 'tâches')
    expect(text).toContain('A 1')
    expect(text).toContain('B 1')
    expect(text).toContain('Total : 2 tâches.')
  })
})

describe('category visual identity', () => {
  it('derives the accent from the stored colour, never from an id', () => {
    expect(JSON.stringify(categoryAccent('#16a34a'))).toContain('#16a34a')
    expect(categoryAccent('not-a-colour')).toBeUndefined()
    expect(categoryAccent(null)).toBeUndefined()
  })

  it('draws a glyph for an unknown key', () => {
    expect(categoryIcon('shield-check')).not.toBe(categoryIcon('something-new'))
    expect(categoryIcon('something-new')).toBe(categoryIcon('sparkles'))
  })
})
