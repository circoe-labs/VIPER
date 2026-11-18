import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { ProspectScore } from '../api/prospects'
import type { Reassessment } from '../api/scoreReassessment'
import { ProspectScoreCard } from './ProspectScoreCard'
import { formatElapsed, QUEUE_TIMEOUT_SECONDS, ScoreReassessment } from './ScoreReassessment'

const PROSPECT = 'prospect-1'
const URL_PART = `/prospects/${PROSPECT}/score/reassessment`

const EVALUATED: ProspectScore = {
  total: 50,
  band: 'yellow',
  summary: 'Un résumé.',
  contributions: [{ id: 'c1', delta: 5, reason: 'Raison', source_type: 'note', source_ref: 'n1', created_at: '2026-09-10T08:00:00+00:00', origin: 'manual' }],
}
const UNEVALUATED: ProspectScore = { ...EVALUATED, contributions: [] }

function state(fields: Partial<Reassessment> = {}): Reassessment {
  return {
    status: 'idle',
    task_id: null,
    mission_id: null,
    run_id: null,
    result_id: null,
    requested_at: null,
    agent_label: null,
    failure_code: null,
    failure_message: null,
    proposal: null,
    decided_by: null,
    decided_at: null,
    agents_available: 1,
    ...fields,
  }
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

// GET answers `current`; POST answers `onPost` (default: queued); DELETE answers cancelled.
function stub(current: Reassessment, onPost: () => Response = () => json(201, state({ status: 'queued', requested_at: new Date().toISOString() }))) {
  const calls: string[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const method = init?.method ?? 'GET'
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      calls.push(`${method} ${url}`)
      if (!url.includes(URL_PART)) return Promise.resolve(json(404, { detail: 'nope' }))
      if (method === 'POST') return Promise.resolve(onPost())
      if (method === 'DELETE') return Promise.resolve(json(200, state({ status: 'cancelled' })))
      return Promise.resolve(json(200, current))
    }),
  )
  return calls
}

function show(score: ProspectScore = EVALUATED) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const { container } = render(
    <QueryClientProvider client={queryClient}>
      <ScoreReassessment prospectId={PROSPECT} score={score} onOpenDetail={vi.fn()} />
    </QueryClientProvider>,
  )
  return container
}

afterEach(() => {
  vi.unstubAllGlobals()
})

const phase = (container: HTMLElement) => container.querySelector('.score-state')?.getAttribute('data-phase')

describe('ScoreReassessment - in-card states', () => {
  it('idle evaluated: level word, summary, « Voir le détail » and « Réévaluer »', async () => {
    stub(state())
    const container = show()

    expect(await screen.findByRole('button', { name: 'Réévaluer le score' })).toBeEnabled()
    expect(screen.getByRole('button', { name: /Voir le détail/ })).toBeInTheDocument()
    expect(screen.getByText('Moyen')).toBeInTheDocument()
    expect(phase(container)).toBe('idle')
  })

  it('not evaluated: dashed disc, « Non évalué » and « Évaluer », no figure', async () => {
    stub(state())
    const container = show(UNEVALUATED)

    expect(await screen.findByRole('button', { name: 'Évaluer' })).toBeEnabled()
    expect(screen.getByText('Non évalué')).toBeInTheDocument()
    expect(container.querySelector('.prospect-score__placeholder')).not.toBeNull()
    expect(container).not.toHaveTextContent('50')
  })

  it('asks, then replaces the body in place with the waiting state, a live counter and a way out', async () => {
    const calls = stub(state())
    const container = show()
    await userEvent.click(await screen.findByRole('button', { name: 'Réévaluer le score' }))

    expect(await screen.findByText('En attente d’un agent')).toBeInTheDocument()
    expect(screen.getByText(/\d+ s/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Annuler la demande d’évaluation' })).toBeEnabled()
    // Replaced, not added: the idle controls are gone, there is still one body.
    expect(screen.queryByRole('button', { name: 'Réévaluer le score' })).not.toBeInTheDocument()
    expect(container.querySelectorAll('.prospect-score')).toHaveLength(1)
    expect(container.querySelector('.score-progress')).not.toBeNull()
    expect(calls.some((call) => call.startsWith('POST'))).toBe(true)
  })

  it('says nobody is connected when no live agent can take the queued task', async () => {
    stub(state({ status: 'queued', requested_at: new Date().toISOString(), agents_available: 0 }))
    show()

    expect(await screen.findByText('Aucun agent connecté')).toBeInTheDocument()
  })

  it('in progress: badge, « Analyse par l’agent… » with the counter, discreet cancel, no idle action', async () => {
    stub(state({ status: 'running', requested_at: new Date(Date.now() - 41_000).toISOString(), agent_label: 'Claude lucie #2' }))
    const container = show()

    expect(await screen.findByText('Évaluation en cours')).toBeInTheDocument()
    expect(screen.getByText(/Analyse par l’agent…/)).toHaveTextContent(/4\d s/)
    expect(screen.getByRole('group')).toHaveAccessibleName('Score prospect : évaluation en cours')
    expect(container.querySelector('.score-progress')).toHaveAttribute('data-mode', 'run')
    expect(container.querySelector('.score-progress')).toHaveAttribute('aria-hidden', 'true')
    expect(screen.getByRole('status')).toHaveTextContent('Évaluation en cours')
  })

  it('proposal: « Proposition 50 → 58 » and « Relire et appliquer » in the same body', async () => {
    stub(
      state({
        status: 'proposal',
        result_id: 'result-1',
        proposal: {
          kind: 'score_reassessment',
          items: [],
          refused: [],
          rationale: 'Décideur d’un site cible.',
          current_total: 50,
          projected_total: 58,
          agent_suggested_total: 58,
          confidence: 70,
          notes: null,
        },
      }),
    )
    const container = show()

    await screen.findByRole('button', { name: 'Relire et appliquer' })
    expect(container.querySelector('.score-state__title')).toHaveTextContent('Proposition 50 → 58')
    expect(screen.getByText('Décideur d’un site cible.')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Relire et appliquer' })).toBeEnabled()
    expect(container.querySelectorAll('.prospect-score')).toHaveLength(1)
  })

  it('failed: one line with the real reason, « Réessayer », the score stays', async () => {
    stub(state({ status: 'failed', failure_message: 'Sources injoignables.' }))
    show()

    expect(await screen.findByText('Évaluation échouée')).toBeInTheDocument()
    expect(screen.getByText(/Sources injoignables/)).toHaveTextContent('Score inchangé')
    expect(screen.getByRole('button', { name: 'Réessayer' })).toBeEnabled()
  })

  it('shows the real refusal when the request itself fails, and releases the action', async () => {
    stub(state(), () => json(404, { detail: { code: 'not_found', message: 'Unknown prospect.' } }))
    show()
    await userEvent.click(await screen.findByRole('button', { name: 'Réévaluer le score' }))

    expect(await screen.findByText('Évaluation échouée')).toBeInTheDocument()
    expect(screen.getByText(/Score inchangé/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Réessayer' })).toBeEnabled()
  })

  it('nothing found and refused proposal replace the summary line, nothing more', async () => {
    stub(state({ status: 'nothing_found' }))
    show()

    expect(await screen.findByText('L’agent n’a rien trouvé qui change le score.')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Réévaluer le score' })).toBeEnabled()
  })

  it('lets the person cancel a waiting request and returns to the idle body', async () => {
    const calls = stub(state({ status: 'queued', requested_at: new Date().toISOString() }))
    show()
    await userEvent.click(await screen.findByRole('button', { name: 'Annuler la demande d’évaluation' }))

    expect(calls.some((call) => call.startsWith('DELETE'))).toBe(true)
    expect(await screen.findByRole('button', { name: 'Réévaluer le score' })).toBeEnabled()
  })

  it('has a deadline: after a long wait it says nobody answered, how long, and that the score is unchanged', async () => {
    const old = new Date(Date.now() - (QUEUE_TIMEOUT_SECONDS + 30) * 1000).toISOString()
    stub(state({ status: 'queued', requested_at: old }))
    const container = show()

    expect(await screen.findByText('Aucun agent n’a répondu')).toBeInTheDocument()
    expect(screen.getByText(/Sans réponse depuis/)).toHaveTextContent('3 min 3')
    expect(screen.getByRole('button', { name: 'Annuler la demande d’évaluation' })).toBeEnabled()
    expect(phase(container)).toBe('stalled')
  })

  it('formats the counter', () => {
    expect(formatElapsed(41)).toBe('41 s')
    expect(formatElapsed(125)).toBe('2 min 05 s')
  })
})

describe('ProspectScoreCard - reassessment seam', () => {
  it('offers the action only when the card is given the saved prospect', async () => {
    stub(state())
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const { rerender } = render(
      <QueryClientProvider client={queryClient}>
        <ProspectScoreCard score={EVALUATED} onShowNote={vi.fn()} />
      </QueryClientProvider>,
    )
    expect(screen.queryByRole('button', { name: 'Réévaluer le score' })).not.toBeInTheDocument()

    rerender(
      <QueryClientProvider client={queryClient}>
        <ProspectScoreCard score={EVALUATED} onShowNote={vi.fn()} prospectId={PROSPECT} />
      </QueryClientProvider>,
    )

    expect(await screen.findByRole('button', { name: 'Réévaluer le score' })).toBeEnabled()
  })
})
