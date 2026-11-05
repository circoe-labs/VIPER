import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'

import type { DataQualityScore } from '../api/prospects'
import { DataQualityCard } from './DataQualityCard'

function quality(overrides: Partial<DataQualityScore> = {}): DataQualityScore {
  return {
    total: 65,
    band: 'yellow',
    summary: 'À compléter : téléphone vérifié, emploi vérifié.',
    criteria: [
      { id: 'email_active', label: 'E-mail actif', points: 20, max_points: 20, detail: 'Un e-mail actif' },
      { id: 'phone_verified', label: 'Téléphone vérifié', points: 0, max_points: 5, detail: 'Aucun téléphone vérifié' },
    ],
    ...overrides,
  }
}

describe('DataQualityCard', () => {
  it('shows the figure, the band in words (not only colour) and the summary', () => {
    render(<DataQualityCard quality={quality()} />)

    expect(screen.getByRole('heading', { name: 'Qualité de la fiche' })).toBeInTheDocument()
    expect(screen.getByText('Correcte')).toBeInTheDocument()
    expect(screen.getByText(/65 sur 100/)).toBeInTheDocument()
    expect(screen.getByText('À compléter : téléphone vérifié, emploi vérifié.')).toBeInTheDocument()
  })

  it('uses the colour band sent by the backend', () => {
    const { container, rerender } = render(<DataQualityCard quality={quality({ band: 'red', total: 10 })} />)
    expect(container.querySelector('.data-quality')).toHaveAttribute('data-band', 'red')
    expect(screen.getByText('Insuffisante')).toBeInTheDocument()

    rerender(<DataQualityCard quality={quality({ band: 'green', total: 95 })} />)
    expect(container.querySelector('.data-quality')).toHaveAttribute('data-band', 'green')
    expect(screen.getByText('Bonne')).toBeInTheDocument()
  })

  it('lists every criterion with its points once opened', async () => {
    const user = userEvent.setup()
    render(<DataQualityCard quality={quality()} />)

    await user.click(screen.getByText('Voir les critères'))

    const list = screen.getByRole('list', { name: 'Critères de qualité de la fiche' })
    const items = within(list).getAllByRole('listitem')
    expect(items).toHaveLength(2)
    expect(items[0]).toHaveTextContent('20/20')
    expect(items[1]).toHaveTextContent('0/5')
    expect(items[1]).toHaveTextContent('Aucun téléphone vérifié')
  })

  it('says « Écarté » for a prospect under opposition and shows nothing without a score', () => {
    const { container, rerender } = render(<DataQualityCard quality={null} discarded />)
    expect(screen.getByText(/Écarté/)).toBeInTheDocument()

    rerender(<DataQualityCard quality={null} />)
    expect(container).toBeEmptyDOMElement()
  })
})
