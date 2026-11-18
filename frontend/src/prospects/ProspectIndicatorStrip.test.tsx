import { render, screen, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { COMPLETENESS_FIXTURE, PROXIMITY_FIXTURE } from './indicators'
import { ProspectIndicatorStrip } from './ProspectIndicatorStrip'

const score = <div data-slot="prospect-score">score</div>

describe('ProspectIndicatorStrip', () => {
  it('shows the semantic completeness state (no figure) and the proximity score when ready', () => {
    render(
      <ProspectIndicatorStrip
        score={score}
        completeness={{ status: 'ready', value: COMPLETENESS_FIXTURE }}
        proximity={{ status: 'ready', value: PROXIMITY_FIXTURE }}
      />,
    )
    const fiche = screen.getByRole('region', { name: 'État de la fiche' })
    expect(fiche).toHaveTextContent('Exploitable')
    expect(fiche).toHaveTextContent('2 à compléter')
    expect(within(fiche).queryByText(/sur 100/)).toBeNull()
    const proximity = screen.getByRole('region', { name: 'Score de proximité' })
    expect(proximity).toHaveTextContent('2 chemins')
    expect(proximity).toHaveTextContent('proximité 64 sur 100')
    expect(screen.getByRole('button', { name: 'Aide : Score de proximité' })).toBeInTheDocument()
  })

  it('shows loading, unavailable and error states without inventing a value', () => {
    const { rerender } = render(
      <ProspectIndicatorStrip score={score} completeness={{ status: 'loading' }} proximity={{ status: 'unavailable' }} />,
    )
    expect(screen.getByRole('status')).toHaveTextContent('Chargement')
    expect(screen.getByRole('region', { name: 'Score de proximité' })).toHaveTextContent('Pas encore calculé')
    rerender(
      <ProspectIndicatorStrip
        score={score}
        completeness={{ status: 'error', message: 'État de la fiche indisponible.' }}
        proximity={{ status: 'unavailable' }}
      />,
    )
    expect(screen.getByRole('alert')).toHaveTextContent('État de la fiche indisponible.')
  })
})
