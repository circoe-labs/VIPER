import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'

import type { MissionOverview } from '../api/missions'
import { SHELL_API } from '../test/homeApi'
import { type ApiReply, renderApp, stubApi } from '../test/render'
import { COMMON, detail, MISSION } from './missionTestData'

function overview(overrides: Partial<MissionOverview> = {}): MissionOverview {
  return {
    mission_id: MISSION,
    name: 'Nouveaux entrepôts — Normandie',
    status: 'active',
    next_run_at: null,
    current_run: {
      id: 'run-1',
      status: 'running',
      scheduled_at: '2026-10-30T08:00:00+00:00',
      started_at: '2026-10-30T08:00:00+00:00',
      finished_at: null,
      tasks_total: 4,
      results_count: 3,
    },
    active_sessions: 1,
    active_agents: 1,
    agents: [
      {
        agent_id: 'a1',
        agent_label: 'Agent claude-01',
        session_id: 's1',
        run_id: 'run-1',
        started_at: '2026-10-30T08:00:00+00:00',
        last_seen_at: new Date().toISOString(),
      },
    ],
    last_activity_at: new Date().toISOString(),
    tasks: {
      total: 4,
      finished: 3,
      by_status: { pending: 0, claimed: 0, submitted: 1, accepted: 2, failed: 1, cancelled: 0 },
    },
    pending_reviews: 2,
    warnings: [],
    ...overrides,
  }
}

function api(reply: ApiReply): Record<string, ApiReply> {
  return {
    ...SHELL_API,
    ...COMMON,
    [`GET /api/missions/${MISSION}`]: [200, detail()],
    [`GET /api/missions/${MISSION}/overview`]: reply,
  }
}

describe('Mission detail tabs', () => {
  it('shows the four tabs with the Vue d’ensemble selected and the pending count on Résultats', async () => {
    stubApi(api([200, overview()]))
    renderApp(`/missions/${MISSION}`)

    await screen.findByText('Agents actifs')
    const tabs = screen.getAllByRole('tab')
    expect(tabs.map((tab) => tab.textContent)).toEqual([
      'Vue d’ensemble',
      'Activité',
      'Résultats2 à relire',
      'Statistiques',
    ])
    expect(tabs[0]).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByText(/Complète ces fiches/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Relire' })).toBeInTheDocument()
  })

  it('switches tab on click and syncs the URL', async () => {
    stubApi(api([200, overview()]))
    const user = userEvent.setup()
    const { router } = renderApp(`/missions/${MISSION}`)

    await user.click(await screen.findByRole('tab', { name: 'Activité' }))
    expect(await screen.findByText('Activité des agents')).toBeInTheDocument()
    expect(router.state.location.search).toBe('?tab=activity')
    expect(screen.queryByText(/Complète ces fiches/)).not.toBeInTheDocument()

    await user.click(screen.getByRole('tab', { name: 'Vue d’ensemble' }))
    expect(router.state.location.search).toBe('')
    expect(await screen.findByText(/Complète ces fiches/)).toBeInTheDocument()
  })

  it('moves between tabs with the arrow keys, Home and End', async () => {
    stubApi(api([200, overview()]))
    const user = userEvent.setup()
    const { router } = renderApp(`/missions/${MISSION}`)

    const first = await screen.findByRole('tab', { name: 'Vue d’ensemble' })
    first.focus()
    await user.keyboard('{ArrowRight}')
    expect(screen.getByRole('tab', { name: 'Activité' })).toHaveFocus()
    expect(router.state.location.search).toBe('?tab=activity')
    await user.keyboard('{End}')
    expect(screen.getByRole('tab', { name: 'Statistiques' })).toHaveFocus()
    expect(screen.getByRole('tab', { name: 'Statistiques' })).toHaveAttribute('aria-selected', 'true')
    expect(router.state.location.search).toBe('?tab=stats')
    await user.keyboard('{Home}')
    expect(first).toHaveFocus()
    expect(first).toHaveAttribute('aria-selected', 'true')
  })

  it('opens the tab named by the URL', async () => {
    stubApi({
      ...api([200, overview()]),
      [`GET /api/missions/${MISSION}/results`]: [
        200,
        { items: [], total: 0, limit: 12, offset: 0, status_counts: { pending_review: 0, accepted: 0, rejected: 0, superseded: 0 } },
      ],
    })
    renderApp(`/missions/${MISSION}?tab=results`)
    expect(await screen.findByText('Rien à relire')).toBeInTheDocument()
    expect(screen.getByRole('tab', { name: /Résultats/ })).toHaveAttribute('aria-selected', 'true')
  })

  it('falls back to the overview on an unknown tab value', async () => {
    stubApi(api([200, overview()]))
    renderApp(`/missions/${MISSION}?tab=nope`)
    expect(await screen.findByText(/Complète ces fiches/)).toBeInTheDocument()
  })

  it('jumps to Résultats from the pending reviews badge of the strip', async () => {
    stubApi(api([200, overview()]))
    const user = userEvent.setup()
    const { router } = renderApp(`/missions/${MISSION}`)

    await user.click(await screen.findByRole('button', { name: '2 résultats à relire' }))
    expect(router.state.location.search).toBe('?tab=results')
  })

  it('keeps the actions reachable from every tab', async () => {
    stubApi(api([200, overview()]))
    renderApp(`/missions/${MISSION}?tab=stats`)
    expect(await screen.findByRole('button', { name: 'Modifier' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Désactiver' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Supprimer' })).toBeInTheDocument()
  })
})

describe('Mission header', () => {
  it('shows status, type, recurrence and agent chips, and no place chip when the rule has no geography', async () => {
    stubApi(api([200, overview()]))
    renderApp(`/missions/${MISSION}`)
    const chips = await screen.findByRole('list', { name: 'Caractéristiques de la mission' })
    expect(within(chips).getByText('Active')).toBeInTheDocument()
    expect(within(chips).getAllByRole('listitem').length).toBeGreaterThanOrEqual(4)
    expect(screen.getByRole('heading', { level: 1 })).toBeInTheDocument()
  })
})

describe('Mission live strip', () => {
  it('shows a loading state while the overview is pending, without blocking the page', async () => {
    stubApi(api(() => new Promise<Response>(() => undefined)))
    renderApp(`/missions/${MISSION}`)
    expect(await screen.findByText('Chargement du suivi en direct…')).toBeInTheDocument()
    expect(screen.getByText(/Complète ces fiches/)).toBeInTheDocument()
  })

  it('shows live agents, progress, last activity and warnings', async () => {
    stubApi(
      api([
        200,
        overview({
          warnings: [
            { code: 'sessions_timed_out', message: 'Des sessions d’agent ont expiré (3 h d’inactivité).', count: 1 },
          ],
        }),
      ]),
    )
    renderApp(`/missions/${MISSION}`)

    expect(await screen.findByText('1 · Agent claude-01')).toBeInTheDocument()
    expect(screen.getByText('3 / 4 tâches traitées')).toBeInTheDocument()
    expect(screen.getByRole('progressbar', { name: 'Progression : 75 %' })).toBeInTheDocument()
    expect(screen.getByText('à l’instant')).toBeInTheDocument()
    expect(screen.getByText(/Des sessions d’agent ont expiré/)).toBeInTheDocument()
  })

  it('says when no agent is active', async () => {
    stubApi(
      api([
        200,
        overview({
          active_agents: 0,
          active_sessions: 0,
          agents: [],
          last_activity_at: null,
          warnings: [{ code: 'no_active_agent', message: 'Aucun agent actif sur cette exécution.', count: 0 }],
        }),
      ]),
    )
    renderApp(`/missions/${MISSION}`)

    expect(await screen.findByText('Aucun')).toBeInTheDocument()
    expect(screen.getByText('Aucune pour l’instant')).toBeInTheDocument()
    expect(screen.getByText('Aucun agent actif sur cette exécution.')).toBeInTheDocument()
  })

  it('shows an empty state before the first run, without invented figures', async () => {
    stubApi(
      api([
        200,
        overview({
          current_run: null,
          active_agents: 0,
          active_sessions: 0,
          agents: [],
          last_activity_at: null,
          pending_reviews: 0,
          tasks: {
            total: 0,
            finished: 0,
            by_status: { pending: 0, claimed: 0, submitted: 0, accepted: 0, failed: 0, cancelled: 0 },
          },
        }),
      ]),
    )
    renderApp(`/missions/${MISSION}`)

    expect(await screen.findByText(/Aucune exécution pour l’instant : le suivi en direct/)).toBeInTheDocument()
    expect(screen.queryByText('Agents actifs')).not.toBeInTheDocument()
  })

  it('says the live view is unavailable, offers a retry, and keeps the rest of the page usable', async () => {
    let calls = 0
    stubApi(
      api(() => {
        calls += 1
        return calls === 1 ? [500, { detail: 'boom' }] : [200, overview()]
      }),
    )
    const user = userEvent.setup()
    renderApp(`/missions/${MISSION}`)

    expect(await screen.findByText('Le suivi en direct est indisponible.')).toBeInTheDocument()
    expect(screen.getByText(/Complète ces fiches/)).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Réessayer' }))
    expect(await screen.findByText('Agents actifs')).toBeInTheDocument()
    await waitFor(() => {
      expect(screen.queryByText('Le suivi en direct est indisponible.')).not.toBeInTheDocument()
    })
  })
})
