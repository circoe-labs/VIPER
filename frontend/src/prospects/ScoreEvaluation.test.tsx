import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { type Prospect, type ProspectScore, prospectKeys } from '../api/prospects'
import { useEvaluateScore } from '../api/scoreEvaluation'
import { ProspectScoreCard } from './ProspectScoreCard'
import { formatElapsed, ScoreEvaluation, SUCCESS_VISIBLE_MS } from './ScoreEvaluation'

const PROSPECT = 'prospect-1'
const URL_PART = `/prospects/${PROSPECT}/score/evaluate`

const EVALUATED: ProspectScore = {
  total: 50,
  band: 'yellow',
  summary: 'Un résumé.',
  contributions: [{ id: 'c1', delta: 5, reason: 'Raison', source_type: 'note', source_ref: 'n1', created_at: '2026-09-10T08:00:00+00:00', origin: 'manual' }],
}
const UNEVALUATED: ProspectScore = { ...EVALUATED, contributions: [] }
const ASSESSED: ProspectScore = {
  total: 82,
  band: 'green',
  summary: 'Directeur général d’une ETI industrielle.',
  contributions: [],
  assessment: {
    id: 'a1',
    rationale: 'Directeur général d’une ETI industrielle.',
    criteria: [
      { label: 'Taille', delta: -3, evidence: 'non renseigné' },
      { label: 'Poste décisionnaire', delta: 25, evidence: 'Directeur général' },
    ],
    model: 'gpt-test',
    prompt_version: 'a1b2c3d4',
    created_at: '2026-11-18T13:02:00+00:00',
    actor_display: 'Camille',
  },
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

// POST answers `onPost` (default: the assessed score); anything else is a 404.
function stub(onPost: () => Promise<Response> | Response = () => json(200, ASSESSED)) {
  const calls: string[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const method = init?.method ?? 'GET'
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      calls.push(`${method} ${url}`)
      if (url.includes(URL_PART) && method === 'POST') return Promise.resolve(onPost())
      return Promise.resolve(json(404, { detail: 'nope' }))
    }),
  )
  return calls
}

// The card reads the score from the prospect's cache, like the editor does: the evaluation writes the new score there.
function Harness({ initial, elsewhere = false }: { initial: ProspectScore; elsewhere?: boolean }) {
  const score = useQuery({ queryKey: prospectKeys.detail(PROSPECT), queryFn: () => ({ score: initial }) as unknown as Prospect, staleTime: Infinity })
  const other = useEvaluateScore(PROSPECT)
  if (!score.data) return null
  return (
    <>
      <ScoreEvaluation prospectId={PROSPECT} score={score.data.score} onOpenDetail={vi.fn()} />
      {elsewhere && (
        <button type="button" onClick={() => { other.start() }}>
          Lancer ailleurs
        </button>
      )}
    </>
  )
}

function show(initial: ProspectScore = EVALUATED, elsewhere = false) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const { container } = render(
    <QueryClientProvider client={queryClient}>
      <Harness initial={initial} elsewhere={elsewhere} />
    </QueryClientProvider>,
  )
  return container
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

const phase = (container: HTMLElement) => container.querySelector('.score-state')?.getAttribute('data-phase')

describe('ScoreEvaluation - in-card states', () => {
  it('idle evaluated: level word, summary, « Voir le détail » and « Réévaluer »', async () => {
    stub()
    const container = show()

    expect(await screen.findByRole('button', { name: 'Réévaluer le score' })).toBeEnabled()
    expect(screen.getByRole('button', { name: /Voir le détail/ })).toBeInTheDocument()
    expect(screen.getByText('Moyen')).toBeInTheDocument()
    expect(phase(container)).toBe('idle')
  })

  it('not evaluated: dashed disc, « Non évalué » and « Évaluer », no figure', async () => {
    stub()
    const container = show(UNEVALUATED)

    expect(await screen.findByRole('button', { name: 'Évaluer' })).toBeEnabled()
    expect(screen.getByText('Non évalué')).toBeInTheDocument()
    expect(container.querySelector('.prospect-score__placeholder')).not.toBeNull()
    expect(container).not.toHaveTextContent('50')
  })

  it('an AI assessment counts as evaluated even without any note', async () => {
    stub()
    const container = show(ASSESSED)

    expect(await screen.findByRole('button', { name: 'Réévaluer le score' })).toBeEnabled()
    expect(container).toHaveTextContent('Élevé')
    expect(phase(container)).toBe('idle')
  })

  it('in progress: the body is replaced in place by the animated ring, the state, a live counter; nothing is added', async () => {
    let finish: (response: Response) => void = () => undefined
    const calls = stub(() => new Promise<Response>((resolve) => { finish = resolve }))
    const container = show()
    await userEvent.click(await screen.findByRole('button', { name: 'Réévaluer le score' }))

    expect(await screen.findByText('Évaluation en cours')).toBeInTheDocument()
    expect(screen.getByText(/L’IA analyse la fiche…/)).toHaveTextContent(/\d+ s/)
    expect(screen.getByRole('group')).toHaveAccessibleName('Score prospect : évaluation en cours')
    expect(container.querySelector('.score-progress')).toHaveAttribute('aria-hidden', 'true')
    expect(screen.getByRole('status')).toHaveTextContent('Évaluation en cours')
    // Replaced, not added: the idle controls are gone, there is still exactly one body.
    expect(screen.queryByRole('button', { name: 'Réévaluer le score' })).not.toBeInTheDocument()
    expect(container.querySelectorAll('.prospect-score')).toHaveLength(1)
    expect(calls.filter((call) => call.startsWith('POST'))).toHaveLength(1)
    finish(json(200, ASSESSED))
    await screen.findByText('Score mis à jour')
  })

  it('success: « Score mis à jour », the new figure and the rationale; then back to rest after a few seconds', async () => {
    stub()
    const container = show()
    await userEvent.click(await screen.findByRole('button', { name: 'Réévaluer le score' }))

    expect(await screen.findByText('Score mis à jour')).toBeInTheDocument()
    expect(phase(container)).toBe('success')
    await waitFor(() => {
      expect(container.querySelector('.score-ring__value')).toHaveTextContent('82')
    })
    expect(container.querySelector('.score-state__detail')).toHaveTextContent('Directeur général d’une ETI industrielle.')
    expect(screen.getByRole('button', { name: /Voir le détail/ })).toBeInTheDocument()
    expect(screen.getByRole('status')).toHaveTextContent('Score mis à jour : 82 sur 100')
    expect(SUCCESS_VISIBLE_MS).toBeGreaterThan(0)
    await waitFor(
      () => {
        expect(phase(container)).toBe('idle')
      },
      { timeout: SUCCESS_VISIBLE_MS + 2000 },
    )
    expect(screen.getByText('Élevé')).toBeInTheDocument()
  }, 15_000)

  it('failure: one line with the real reason pointing to Config AI, the score stays, « Réessayer » asks again', async () => {
    let attempts = 0
    stub(() => {
      attempts += 1
      return attempts === 1 ? json(503, { detail: { code: 'ai_not_configured', message: 'not configured' } }) : json(200, ASSESSED)
    })
    const container = show()
    await userEvent.click(await screen.findByRole('button', { name: 'Réévaluer le score' }))

    expect(await screen.findByText('Échec · score inchangé')).toBeInTheDocument()
    expect(container.querySelector('.score-state__detail')).toHaveTextContent(/Config AI › Connexions/)
    expect(phase(container)).toBe('failed')
    // The previous figure is still there.
    expect(container.querySelector('.score-ring__value')).toHaveTextContent('50')
    expect(screen.getByRole('status')).toHaveTextContent('Le score actuel reste valable')

    await userEvent.click(screen.getByRole('button', { name: 'Réessayer' }))

    expect(await screen.findByText('Score mis à jour')).toBeInTheDocument()
    expect(attempts).toBe(2)
  })

  it('a request that never answers ends with how long it waited, and releases the action', async () => {
    stub(() => Promise.reject(new DOMException('The operation timed out.', 'TimeoutError')))
    const container = show()
    await userEvent.click(await screen.findByRole('button', { name: 'Réévaluer le score' }))

    expect(await screen.findByRole('button', { name: 'Réessayer' })).toBeEnabled()
    expect(container.querySelector('.score-state__detail')).toHaveTextContent('Pas de réponse après 120 s.')
  })

  it('a malformed AI answer and an unreachable server are each said as what they are', async () => {
    stub(() => json(502, { detail: { code: 'ai_invalid_output', message: 'bad' } }))
    show()
    await userEvent.click(await screen.findByRole('button', { name: 'Réévaluer le score' }))

    expect((await screen.findAllByText('La réponse de l’IA était inutilisable.')).length).toBeGreaterThan(0)
  })

  it('shows the progress of an evaluation started elsewhere (the Mission menu, the « … » menu)', async () => {
    let finish: (response: Response) => void = () => undefined
    stub(() => new Promise<Response>((resolve) => { finish = resolve }))
    const container = show(EVALUATED, true)

    await userEvent.click(await screen.findByRole('button', { name: 'Lancer ailleurs' }))

    expect(await screen.findByText('Évaluation en cours')).toBeInTheDocument()
    expect(phase(container)).toBe('running')
    finish(json(200, ASSESSED))
    expect(await screen.findByText('Score mis à jour')).toBeInTheDocument()
  })

  it('formats the counter', () => {
    expect(formatElapsed(41)).toBe('41 s')
    expect(formatElapsed(125)).toBe('2 min 05 s')
  })
})

describe('ProspectScoreCard - evaluation seam and detail', () => {
  it('offers the action only when the card is given the saved prospect', async () => {
    stub()
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

  it('« Voir le détail » shows the criteria, the rationale and the provenance of the AI assessment', async () => {
    stub()
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(
      <QueryClientProvider client={queryClient}>
        <ProspectScoreCard score={ASSESSED} onShowNote={vi.fn()} prospectId={PROSPECT} />
      </QueryClientProvider>,
    )

    await userEvent.click(await screen.findByRole('button', { name: /Voir le détail/ }))

    const dialog = await screen.findByRole('dialog')
    expect(dialog).toHaveTextContent('82')
    const criteria = screen.getByRole('list', { name: 'Critères de l’évaluation' })
    expect(criteria.textContent).toContain('+25')
    expect(criteria.textContent).toContain('Poste décisionnaire')
    expect(criteria.textContent).toContain('Directeur général')
    const text = criteria.textContent
    expect(text.indexOf('Poste décisionnaire')).toBeLessThan(text.indexOf('Taille'))
    expect(dialog).toHaveTextContent('modèle gpt-test')
    expect(dialog).toHaveTextContent('prompt a1b2c3d4')
    expect(dialog).toHaveTextContent('demandé par Camille')
  })
})
