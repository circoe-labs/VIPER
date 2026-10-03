import { render } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { ScoreRing } from './ScoreRing'

function ring(value: number, tone: 'danger' | 'warning' | 'success' | 'neutral' = 'warning') {
  const { container } = render(<ScoreRing value={value} tone={tone} />)
  const svg = container.querySelector('svg')
  if (!svg) throw new Error('No ring.')
  return svg
}

describe('ScoreRing', () => {
  it.each([0, 1, 50, 99, 100])('draws %i out of 100 as an arc of that length and writes it', (value) => {
    const svg = ring(value)

    expect(svg.querySelector('.score-ring__value')).toHaveTextContent(String(value))
    const arc = svg.querySelector('.score-ring__arc')
    if (value === 0) expect(arc).toBeNull()
    else expect(arc).toHaveAttribute('stroke-dasharray', `${String(value)} ${String(100 - value)}`)
  })

  it('clamps and rounds what is out of range', () => {
    expect(ring(140).querySelector('.score-ring__value')).toHaveTextContent('100')
    expect(ring(-4).querySelector('.score-ring__value')).toHaveTextContent('0')
    expect(ring(49.6).querySelector('.score-ring__value')).toHaveTextContent('50')
    expect(ring(Number.NaN).querySelector('.score-ring__value')).toHaveTextContent('0')
  })

  it('is decorative for assistive technologies and carries its tone for the styles', () => {
    const svg = ring(70, 'success')

    expect(svg).toHaveAttribute('aria-hidden', 'true')
    expect(svg).toHaveAttribute('data-tone', 'success')
  })
})
