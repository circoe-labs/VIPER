import { render as rtlRender, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ReactElement } from 'react'
import { MemoryRouter } from 'react-router'
import { describe, expect, it, vi } from 'vitest'

import { prospectDetail } from '../test/prospectsApi'
import { splitCriteria } from './completenessView'
import { completenessIndicator } from './indicatorSources'
import type { CompletenessView, ProximityView } from './indicators'
import { ProspectIndicatorStrip } from './ProspectIndicatorStrip'
import { prospectGraphHref } from './prospectGraphHref'
import { proximityTone } from './proximityView'

const score = <div data-slot="prospect-score">score</div>

const USABLE: CompletenessView = {
  state: 'usable',
  label: 'Exploitable',
  description: 'On peut joindre la personne, mais plusieurs informations manquent.',
  missing: ['Téléphone vérifié', 'Intitulé exact'],
  strong: ['E-mail actif'],
}
const REACHABLE: ProximityView = {
  prospectId: 'p-9',
  state: 'reachable',
  total: 64,
  pathCount: 2,
  bestPath: 'Robin (amis, 80) → Yamina',
  maxHops: 3,
}

// The strip holds a router Link (« Graph »).
function render(ui: ReactElement) {
  const wrap = (node: ReactElement) => <MemoryRouter>{node}</MemoryRouter>
  const view = rtlRender(wrap(ui))
  return {
    ...view,
    rerender: (next: ReactElement) => {
      view.rerender(wrap(next))
    },
  }
}

describe('ProspectIndicatorStrip', () => {
  it('shows the semantic completeness state (no figure) and the proximity score when ready', () => {
    render(<ProspectIndicatorStrip score={score} completeness={{ status: 'ready', value: USABLE }} proximity={{ status: 'ready', value: REACHABLE }} />)
    const fiche = screen.getByRole('region', { name: 'État de la fiche' })
    expect(fiche).toHaveTextContent('Exploitable')
    expect(within(fiche).queryByText(/sur 100/)).toBeNull()
    expect(within(fiche).getByRole('button', { name: 'Aide : fiche exploitable' })).toBeInTheDocument()
    const proximity = screen.getByRole('region', {
      name: 'Score de proximité',
    })
    expect(proximity).toHaveTextContent('2 chemins')
    expect(proximity).toHaveTextContent('Accessible')
    expect(proximity).toHaveTextContent('proximité 64 sur 100')
    expect(proximity).toHaveTextContent('Robin (amis, 80) → Yamina')
    expect(screen.getByRole('button', { name: 'Aide : Score de proximité' })).toBeInTheDocument()
  })

  it('offers « Graph » on the prospect when relations exist, and nothing when there is none', () => {
    const { rerender } = render(
      <ProspectIndicatorStrip score={score} completeness={{ status: 'unavailable' }} proximity={{ status: 'ready', value: REACHABLE }} />,
    )
    const link = within(screen.getByRole('region', { name: 'Score de proximité' })).getByRole('link', { name: 'Graph' })
    expect(link).toHaveAttribute('href', prospectGraphHref('p-9'))
    rerender(
      <ProspectIndicatorStrip
        score={score}
        completeness={{ status: 'unavailable' }}
        proximity={{
          status: 'ready',
          value: {
            ...REACHABLE,
            state: 'empty',
            total: 0,
            pathCount: 0,
            bestPath: null,
          },
        }}
      />,
    )
    expect(screen.queryByRole('link', { name: 'Graph' })).not.toBeInTheDocument()
  })

  it.each([
    ['incomplete', 'warning'],
    ['usable', 'info'],
    ['rich', 'success'],
    ['very_rich', 'success'],
  ] as const)('draws the %s fiche as a banner (state word only, criteria in the tip, no ring)', (state, tone) => {
    render(
      <ProspectIndicatorStrip
        score={score}
        completeness={{
          status: 'ready',
          value: { ...USABLE, state, label: 'Mot' },
        }}
        proximity={{ status: 'unavailable' }}
      />,
    )
    const fiche = screen.getByRole('region', { name: 'État de la fiche' })
    const banner = fiche.querySelector('.fiche-state')
    expect(banner).toHaveAttribute('data-tone', tone)
    expect(banner?.querySelector('svg.score-ring')).toBeNull()
    expect(fiche).not.toHaveTextContent('à compléter')
    expect(within(fiche).getByRole('button', { name: 'Aide : fiche mot' })).toHaveAccessibleDescription(/Téléphone vérifié · Intitulé exact/)
  })

  it('says why a proximity of 0 is 0 (empty, unreachable)', () => {
    const { rerender } = render(
      <ProspectIndicatorStrip
        score={score}
        completeness={{ status: 'unavailable' }}
        proximity={{
          status: 'ready',
          value: {
            ...REACHABLE,
            state: 'empty',
            total: 0,
            pathCount: 0,
            bestPath: null,
          },
        }}
      />,
    )
    expect(screen.getByRole('region', { name: 'Score de proximité' })).toHaveTextContent('Aucune relation enregistrée')
    rerender(
      <ProspectIndicatorStrip
        score={score}
        completeness={{ status: 'unavailable' }}
        proximity={{
          status: 'ready',
          value: {
            ...REACHABLE,
            state: 'unreachable',
            total: 0,
            pathCount: 0,
            bestPath: null,
          },
        }}
      />,
    )
    expect(screen.getByRole('region', { name: 'Score de proximité' })).toHaveTextContent('Aucun membre Circoe relié')
  })

  it('shows loading, unavailable (with its reason) and a retryable error without inventing a value', async () => {
    const onRetry = vi.fn()
    const { rerender } = render(<ProspectIndicatorStrip score={score} completeness={{ status: 'loading' }} proximity={{ status: 'unavailable' }} />)
    expect(screen.getByRole('status')).toHaveTextContent('Chargement')
    expect(screen.getByRole('region', { name: 'Score de proximité' })).toHaveTextContent('Pas encore calculé')
    rerender(
      <ProspectIndicatorStrip
        score={score}
        completeness={{
          status: 'unavailable',
          reason: 'Écarté : pas d’évaluation',
        }}
        proximity={{
          status: 'error',
          message: 'Le score de proximité n’a pas pu être calculé.',
          onRetry,
        }}
      />,
    )
    expect(screen.getByRole('region', { name: 'État de la fiche' })).toHaveTextContent('Écarté')
    expect(screen.getByRole('alert')).toHaveTextContent('n’a pas pu être calculé')
    await userEvent.click(screen.getByRole('button', { name: 'Réessayer' }))
    expect(onRetry).toHaveBeenCalledOnce()
  })
})

describe('completenessIndicator (prospect.data_quality)', () => {
  const base = prospectDetail()
  const quality = {
    ...(base.data_quality as NonNullable<typeof base.data_quality>),
    state: 'usable' as const,
    state_label: 'Exploitable',
    state_description: 'Joignable, mais incomplète.',
    summary: 'À compléter : téléphone.',
    criteria: [
      {
        id: 'email',
        label: 'E-mail actif',
        status: 'met' as const,
        detail: 'ok',
        points: 1,
        max_points: 1,
      },
      {
        id: 'phone',
        label: 'Téléphone vérifié',
        status: 'missing' as const,
        detail: 'aucun',
        points: 0,
        max_points: 1,
      },
    ],
  }

  it('maps the backend state to the view, with what is missing', () => {
    expect(completenessIndicator({ ...base, data_quality: quality })).toEqual({
      status: 'ready',
      value: {
        state: 'usable',
        label: 'Exploitable',
        description: 'Joignable, mais incomplète. À compléter : téléphone.',
        missing: ['Téléphone vérifié'],
        strong: ['E-mail actif'],
      },
    })
  })

  it('is unavailable without a prospect and says « Écarté » under opposition', () => {
    expect(completenessIndicator(null)).toEqual({ status: 'unavailable' })
    expect(completenessIndicator({ ...base, data_quality: null })).toMatchObject({
      status: 'unavailable',
      reason: expect.stringContaining('Écarté') as unknown,
    })
  })
})

describe('completenessView / proximityView', () => {
  it('splits criteria missing first, then partial, then acquired', () => {
    const { todo, done } = splitCriteria({
      state: 'usable',
      state_label: '',
      state_description: '',
      summary: '',
      criteria: [
        { id: 'a', label: 'A', status: 'partial', detail: '' },
        { id: 'b', label: 'B', status: 'met', detail: '' },
        { id: 'c', label: 'C', status: 'missing', detail: '' },
      ],
    })
    expect(todo.map((c) => c.id)).toEqual(['c', 'a'])
    expect(done.map((c) => c.id)).toEqual(['b'])
  })

  it.each([
    [0, 'neutral'],
    [34, 'warning'],
    [67, 'success'],
  ] as const)('tones proximity %i as %s', (value, tone) => {
    expect(proximityTone(value)).toBe(tone)
  })
})
