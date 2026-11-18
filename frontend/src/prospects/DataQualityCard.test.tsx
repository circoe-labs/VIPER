import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'

import type { ProfileCompleteness } from '../api/profileCompleteness'
import { DataQualityCard } from './DataQualityCard'

function completeness(overrides: Partial<ProfileCompleteness> = {}): ProfileCompleteness {
  return {
    state: 'usable',
    state_label: 'Exploitable',
    state_description: 'On peut joindre la personne, mais plusieurs informations manquent.',
    summary: 'À compléter : téléphone vérifié, emploi vérifié.',
    criteria: [
      { id: 'email_active', label: 'E-mail actif', status: 'met', detail: 'Un e-mail actif' },
      { id: 'phone_verified', label: 'Téléphone vérifié', status: 'missing', detail: 'Aucun téléphone vérifié' },
      { id: 'employment', label: 'Emploi vérifié', status: 'partial', detail: 'À revérifier' },
    ],
    ...overrides,
  }
}

describe('DataQualityCard', () => {
  it('shows the state in words, its meaning and the summary, and no number', () => {
    const { container } = render(<DataQualityCard quality={completeness()} />)

    expect(screen.getByRole('heading', { name: 'Qualité de la fiche' })).toBeInTheDocument()
    expect(screen.getByText('Exploitable')).toBeInTheDocument()
    expect(screen.getByText('On peut joindre la personne, mais plusieurs informations manquent.')).toBeInTheDocument()
    expect(screen.getByText('À compléter : téléphone vérifié, emploi vérifié.')).toBeInTheDocument()
    expect(container.textContent).not.toMatch(/\d+\s*(\/|sur)\s*\d+/)
    expect(container.querySelector('svg[role="img"][aria-valuenow]')).toBeNull()
  })

  it.each([
    ['incomplete', 'Incomplète', 1],
    ['usable', 'Exploitable', 2],
    ['rich', 'Fournie', 3],
    ['very_rich', 'Très fournie', 4],
  ] as const)('renders %s as « %s » with %i meter step(s)', (state, label, steps) => {
    const { container } = render(<DataQualityCard quality={completeness({ state, state_label: label })} />)

    expect(screen.getByText(label)).toBeInTheDocument()
    expect(container.querySelectorAll('.completeness__step[data-on="true"]')).toHaveLength(steps)
  })

  it('still renders a state the frontend does not know, without a meter', () => {
    const { container } = render(
      <DataQualityCard quality={completeness({ state: 'galactic' as ProfileCompleteness['state'], state_label: 'Galactique' })} />,
    )

    expect(screen.getByText('Galactique')).toBeInTheDocument()
    expect(container.querySelector('.completeness__meter')).toBeNull()
  })

  it('lists what is missing first, then what is acquired, with the status in words', async () => {
    const user = userEvent.setup()
    render(<DataQualityCard quality={completeness()} />)

    await user.click(screen.getByText('Voir les critères'))

    const todo = within(screen.getByRole('list', { name: 'Critères à compléter' })).getAllByRole('listitem')
    expect(todo).toHaveLength(2)
    expect(todo[0]).toHaveTextContent('Téléphone vérifié')
    expect(todo[0]).toHaveTextContent('Manquant')
    expect(todo[1]).toHaveTextContent('Partiel')
    const done = within(screen.getByRole('list', { name: 'Critères acquis' })).getAllByRole('listitem')
    expect(done).toHaveLength(1)
    expect(done[0]).toHaveTextContent('Complet')
  })

  it('says « Écarté » for a prospect under opposition', () => {
    render(<DataQualityCard quality={null} discarded />)
    expect(screen.getByText(/Écarté/)).toBeInTheDocument()
  })

  it('says so when the completeness is unavailable, and shows nothing for an unsaved prospect', () => {
    const { container, rerender } = render(<DataQualityCard quality={null} unavailable />)
    expect(screen.getByRole('alert')).toHaveTextContent('Complétude indisponible')

    rerender(<DataQualityCard quality={null} />)
    expect(container).toBeEmptyDOMElement()
  })
})
