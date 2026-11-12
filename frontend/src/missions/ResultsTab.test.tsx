import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'

import { RESULT_ID, resultCard, resultPage, resultView } from '../agents/reviewTestData'
import { SHELL_API } from '../test/homeApi'
import { type ApiReply, renderApp, stubApi } from '../test/render'
import { COMMON, detail, MISSION } from './missionTestData'

function api(results: ApiReply, extra: Record<string, ApiReply> = {}): Record<string, ApiReply> {
  return {
    ...SHELL_API,
    ...COMMON,
    [`GET /api/missions/${MISSION}`]: [200, detail()],
    [`GET /api/missions/${MISSION}/overview`]: [404, {}],
    [`GET /api/missions/${MISSION}/results`]: results,
    ...extra,
  }
}

function resultCalls(fetchMock: ReturnType<typeof stubApi>): URL[] {
  return fetchMock.mock.calls
    .map(([input]) => new URL(input, 'http://localhost'))
    .filter((url) => url.pathname === `/api/missions/${MISSION}/results`)
}

describe('Results tab', () => {
  it('lists the pending results as cards with agent, summary, confidence, counts and status', async () => {
    const fetchMock = stubApi(api([200, resultPage([resultCard()])]))
    renderApp(`/missions/${MISSION}?tab=results`)

    const list = await screen.findByRole('list', { name: 'Résultats des agents' })
    const card = within(list).getByRole('button')
    expect(within(card).getByText(/Mettre à jour la société/)).toBeInTheDocument()
    expect(within(card).getByText(/2SN/)).toBeInTheDocument()
    expect(within(card).getByText('Société confirmée sur deux sources.')).toBeInTheDocument()
    expect(within(card).getByText('Confiance élevée · 88 %')).toBeInTheDocument()
    expect(within(card).getByText('4 propositions')).toBeInTheDocument()
    expect(within(card).getByText('1 écartée')).toBeInTheDocument()
    expect(within(card).getByText('2 sources')).toBeInTheDocument()
    expect(within(card).getByText('À relire')).toBeInTheDocument()
    expect(within(card).getByText('Agent claude-01')).toBeInTheDocument()
    expect(within(card).getByText(/soumis il y a 5 min/)).toBeInTheDocument()
    // the queue opens on what needs a decision
    const first = resultCalls(fetchMock)[0]
    expect(first?.searchParams.getAll('status')).toEqual(['pending_review'])
    expect(first?.searchParams.get('limit')).toBe('12')
  })

  it('shows status counts and says when a card has no summary or no confidence (historical result)', async () => {
    stubApi(api([200, resultPage([resultCard({ summary: null, confidence: null })])]))
    renderApp(`/missions/${MISSION}?tab=results`)

    expect(await screen.findByText('Aucun résumé fourni par l’agent.')).toBeInTheDocument()
    expect(screen.getByText('Confiance non renseignée')).toBeInTheDocument()
    const group = screen.getByRole('group', { name: 'Statut du résultat' })
    expect(within(group).getByRole('button', { name: /^À relire\s*1$/ })).toHaveAttribute('aria-pressed', 'true')
    expect(within(group).getByRole('button', { name: /^Validé\s*2$/ })).toBeInTheDocument()
    expect(within(group).getByRole('button', { name: /^Tous\s*4$/ })).toBeInTheDocument()
  })

  it('filters by status and agent and resets the page', async () => {
    const fetchMock = stubApi(api([200, resultPage([resultCard()], { total: 30 })]))
    const user = userEvent.setup()
    renderApp(`/missions/${MISSION}?tab=results`)
    await screen.findByRole('list', { name: 'Résultats des agents' })

    await user.click(screen.getByRole('button', { name: /Suivants/ }))
    await waitFor(() => {
      expect(resultCalls(fetchMock).at(-1)?.searchParams.get('offset')).toBe('12')
    })

    await user.click(screen.getByRole('button', { name: /^Validé/ }))
    await waitFor(() => {
      const last = resultCalls(fetchMock).at(-1)
      expect(last?.searchParams.getAll('status')).toEqual(['accepted'])
      expect(last?.searchParams.get('offset')).toBe('0')
    })

    await user.click(screen.getByRole('button', { name: /^Tous/ }))
    await waitFor(() => {
      expect(resultCalls(fetchMock).at(-1)?.searchParams.has('status')).toBe(false)
    })

    await user.selectOptions(screen.getByRole('combobox', { name: 'Agent' }), 'agent-1')
    await waitFor(() => {
      expect(resultCalls(fetchMock).at(-1)?.searchParams.get('agent_id')).toBe('agent-1')
    })
  })

  it('filters by run', async () => {
    const fetchMock = stubApi(api([200, resultPage([resultCard()])]))
    const user = userEvent.setup()
    renderApp(`/missions/${MISSION}?tab=results`)
    await screen.findByRole('list', { name: 'Résultats des agents' })

    const run = detail().runs[0]
    expect(run).toBeDefined()
    const select = screen.getByRole('combobox', { name: 'Exécution' })
    await waitFor(() => {
      expect(within(select).getAllByRole('option')).toHaveLength(2)
    })
    await user.selectOptions(select, run?.id ?? '')
    await waitFor(() => {
      expect(resultCalls(fetchMock).at(-1)?.searchParams.get('run_id')).toBe(run?.id)
    })
  })

  it('explains an empty queue and offers all results when filters hide them', async () => {
    stubApi(api([200, resultPage([], { status_counts: { pending_review: 0, accepted: 2, rejected: 0, superseded: 0 } })]))
    const user = userEvent.setup()
    renderApp(`/missions/${MISSION}?tab=results`)

    expect(await screen.findByText('Rien à relire')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: /^Validé/ }))
    expect(await screen.findByText('Aucun résultat pour ces filtres')).toBeInTheDocument()
  })

  it('reports a load failure with a retry', async () => {
    stubApi(api([500, { detail: 'boom' }]))
    renderApp(`/missions/${MISSION}?tab=results`)
    const alert = await screen.findByText(/Les résultats n’ont pas pu être chargés/)
    expect(within(alert).getByRole('button', { name: 'Réessayer' })).toBeInTheDocument()
  })

  it('opens the validation dialog from a card and gives focus back to the card on close', async () => {
    stubApi(api([200, resultPage([resultCard()])], { [`GET /api/agents/results/${RESULT_ID}`]: [200, resultView()] }))
    const user = userEvent.setup()
    renderApp(`/missions/${MISSION}?tab=results`)

    const card = await screen.findByRole('button', { name: /Mettre à jour la société/ })
    await user.click(card)
    const dialog = await screen.findByRole('dialog')
    expect(await within(dialog).findByText('Confiance globale')).toBeInTheDocument()

    await user.keyboard('{Escape}')
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    })
    expect(card).toHaveFocus()
  })
})
