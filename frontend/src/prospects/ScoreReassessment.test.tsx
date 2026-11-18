import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { ProspectScore } from '../api/prospects'
import type { Reassessment } from '../api/scoreReassessment'
import { ProspectScoreCard } from './ProspectScoreCard'
import { ScoreReassessment } from './ScoreReassessment'

const PROSPECT = 'prospect-1'
const URL_PART = `/prospects/${PROSPECT}/score/reassessment`

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

function show(evaluated = true) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={queryClient}>
      <ScoreReassessment prospectId={PROSPECT} evaluated={evaluated} />
    </QueryClientProvider>,
  )
}

afterEach(() => {
  vi.unstubAllGlobals()
})

const ask = () => screen.getByRole('button', { name: 'Réévaluer le score' })

describe('ScoreReassessment', () => {
  it('reads « Évaluer » while the prospect has no evaluation yet', () => {
    stub(state())
    show(false)

    expect(screen.getByRole('button', { name: 'Évaluer' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Réévaluer le score' })).not.toBeInTheDocument()
  })

  it('asks for a reassessment and shows the waiting state with a counter and a way out', async () => {
    const calls = stub(state())
    show()
    await userEvent.click(await screen.findByRole('button', { name: 'Réévaluer le score' }))

    expect(await screen.findByText(/En attente d’un agent/)).toBeInTheDocument()
    expect(screen.getByText(/\d+ s/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Annuler la demande' })).toBeEnabled()
    expect(ask()).toBeDisabled()
    expect(calls.some((call) => call.startsWith('POST'))).toBe(true)
  })

  it('explains the action in an info tip', async () => {
    stub(state())
    show()

    expect(await screen.findByText(/Rien ne change tant que vous n’avez pas validé/)).toBeInTheDocument()
  })

  it('shows the proposal with its projection and keeps the score untouched until it is reviewed', async () => {
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
    show()

    expect(await screen.findByText('Proposition à relire')).toBeInTheDocument()
    expect(screen.getByText('Décideur d’un site cible.')).toBeInTheDocument()
    expect(screen.getByText(/Score 50/)).toHaveTextContent('58')
    expect(screen.getByRole('button', { name: 'Relire et appliquer' })).toBeEnabled()
    expect(ask()).toBeDisabled()
  })

  it('says why a failed reassessment failed and says the current score stays valid', async () => {
    stub(state({ status: 'failed', failure_message: 'Sources injoignables' }))
    show()

    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('Sources injoignables')
    expect(alert).toHaveTextContent('Le score actuel reste valable')
    expect(ask()).toBeEnabled()
  })

  it('shows the real refusal when the request itself fails, and releases the button', async () => {
    stub(state(), () => json(404, { detail: { code: 'not_found', message: 'Unknown prospect.' } }))
    show()
    await userEvent.click(await screen.findByRole('button', { name: 'Réévaluer le score' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('Le score actuel reste valable')
    expect(ask()).toBeEnabled()
  })

  it('tells that the agent found nothing, and that a refused proposal changed nothing', async () => {
    stub(state({ status: 'nothing_found' }))
    show()

    expect(await screen.findByText('L’agent n’a rien trouvé qui change le score.')).toBeInTheDocument()
  })

  it('lets the person cancel a waiting request', async () => {
    const calls = stub(state({ status: 'queued', requested_at: new Date().toISOString() }))
    show()
    await userEvent.click(await screen.findByRole('button', { name: 'Annuler la demande' }))

    expect(calls.some((call) => call.startsWith('DELETE'))).toBe(true)
    expect(await screen.findByRole('button', { name: 'Réévaluer le score' })).toBeEnabled()
  })

  it('says so when no agent answered for too long', async () => {
    const old = new Date(Date.now() - 11 * 60_000).toISOString()
    stub(state({ status: 'queued', requested_at: old }))
    show()

    expect(await screen.findByText(/Toujours sans réponse après 10 min/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Annuler la demande' })).toBeEnabled()
  })
})

describe('ProspectScoreCard - reassessment seam', () => {
  const score: ProspectScore = { total: 50, band: 'yellow', summary: 'Un résumé.', contributions: [] }

  it('offers the action only when the card is given the saved prospect', async () => {
    stub(state())
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const { rerender } = render(
      <QueryClientProvider client={queryClient}>
        <ProspectScoreCard score={score} onShowNote={vi.fn()} />
      </QueryClientProvider>,
    )
    expect(screen.queryByRole('button', { name: 'Évaluer' })).not.toBeInTheDocument()

    rerender(
      <QueryClientProvider client={queryClient}>
        <ProspectScoreCard score={score} onShowNote={vi.fn()} prospectId={PROSPECT} />
      </QueryClientProvider>,
    )

    expect(await screen.findByRole('button', { name: 'Évaluer' })).toBeEnabled()
  })
})
