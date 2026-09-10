import { render, screen, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { Badge, StatusBadge, type StatusTone } from './Badge'
import { Card } from './Card'
import { EmptyState } from './EmptyState'
import { DatabaseIcon } from './icons'
import { Table } from './Table'

describe('StatusBadge', () => {
  it.each<[StatusTone, string]>([
    ['success', 'Vérifié'],
    ['warning', 'Non vérifié'],
    ['danger', 'Ne pas contacter'],
    ['info', 'Information'],
    ['neutral', 'Inconnu'],
  ])('%s carries a glyph and a text label, not colour alone', (tone, label) => {
    render(<StatusBadge tone={tone}>{label}</StatusBadge>)

    const badge = screen.getByText(label)
    expect(badge).toHaveClass(`badge--${tone}`)
    expect(badge.querySelector('svg')).toHaveAttribute('aria-hidden', 'true')
    expect(badge).toHaveTextContent(label)
  })

  it('uses a distinct default glyph for each tone', () => {
    const tones: StatusTone[] = ['success', 'warning', 'danger', 'info', 'neutral']
    render(
      <>
        {tones.map((tone) => (
          <StatusBadge key={tone} tone={tone}>
            {tone}
          </StatusBadge>
        ))}
      </>,
    )

    const glyphs = tones.map((tone) => screen.getByText(tone).querySelector('svg')?.innerHTML)
    expect(new Set(glyphs).size).toBe(tones.length)
  })

  it('renders plain tags without a status glyph', () => {
    render(<Badge tone="accent">12</Badge>)

    expect(screen.getByText('12').querySelector('svg')).toBeNull()
  })
})

describe('surfaces', () => {
  it('names a titled card as a region', () => {
    render(<Card title="Imports récents">contenu</Card>)

    expect(screen.getByRole('region', { name: 'Imports récents' })).toHaveTextContent('contenu')
  })

  it('exposes tables through a focusable, named scroll region and caption', () => {
    render(
      <Table caption="Prospects" density="compact">
        <tbody>
          <tr>
            <td>ligne</td>
          </tr>
        </tbody>
      </Table>,
    )

    const region = screen.getByRole('region', { name: 'Prospects' })
    expect(region).toHaveAttribute('tabindex', '0')
    expect(within(region).getByRole('table', { name: 'Prospects' })).toHaveClass('table--compact')
  })

  it('titles empty states with a heading', () => {
    render(<EmptyState icon={DatabaseIcon} title="Aucune table" description="Rien à afficher." />)

    expect(screen.getByRole('heading', { level: 2, name: 'Aucune table' })).toBeInTheDocument()
    expect(screen.getByText('Rien à afficher.')).toBeInTheDocument()
  })
})
