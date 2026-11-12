import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'

import type { ActivityEntry, ActivityPage, AgentSession, AgentSessionPage } from '../api/missions'
import { SHELL_API } from '../test/homeApi'
import { type ApiReply, renderApp, stubApi } from '../test/render'
import { COMMON, detail, MISSION } from './missionTestData'

const RUN = '00000000-0000-7000-e000-000000000020'
const NOW = Date.now()
const ago = (minutes: number) => new Date(NOW - minutes * 60_000).toISOString()

function session(overrides: Partial<AgentSession> = {}): AgentSession {
  return {
    id: 's1',
    run_id: RUN,
    agent_id: 'a1',
    agent_label: 'Agent claude-01',
    status: 'active',
    started_at: ago(30),
    last_seen_at: ago(2),
    ended_at: null,
    disconnect_reason: null,
    logs_count: 12,
    ...overrides,
  }
}

function entry(overrides: Partial<ActivityEntry> = {}): ActivityEntry {
  return {
    id: 'l1',
    session_id: 's1',
    run_id: RUN,
    task_id: null,
    agent_id: 'a1',
    agent_label: 'Agent claude-01',
    session_status: 'active',
    event_type: 'search',
    message: 'Recherche du SIREN de Transports X.',
    source_url: null,
    source_published_at: null,
    created_at: ago(5),
    metadata: {},
    ...overrides,
  }
}

function sessionsPage(items: AgentSession[]): AgentSessionPage {
  return { items, total: items.length, limit: 100, offset: 0 }
}

function api(sessions: ApiReply, activity: ApiReply): Record<string, ApiReply> {
  return {
    ...SHELL_API,
    ...COMMON,
    [`GET /api/missions/${MISSION}`]: [200, detail()],
    [`GET /api/missions/${MISSION}/overview`]: [500, { detail: 'x' }],
    [`GET /api/missions/${MISSION}/sessions`]: sessions,
    [`GET /api/missions/${MISSION}/activity`]: activity,
  }
}

const PATH = `/missions/${MISSION}?tab=activity`

describe('Activité tab', () => {
  it('lists concurrent agent sessions with status, relative times and log count', async () => {
    stubApi(
      api(
        [
          200,
          sessionsPage([
            session(),
            session({
              id: 's2',
              agent_id: 'a2',
              agent_label: 'Agent claude-02',
              logs_count: 0,
              status: 'ended',
              disconnect_reason: 'run_finished',
            }),
          ]),
        ],
        [200, { items: [], next_cursor: null } satisfies ActivityPage],
      ),
    )
    renderApp(PATH)

    const list = await screen.findByRole('list', {
      name: 'Sessions des agents',
    })
    const cards = within(list).getAllByRole('listitem')
    expect(cards).toHaveLength(2)
    expect(within(cards[0] as HTMLElement).getByText('Agent claude-01')).toBeInTheDocument()
    expect(within(cards[0] as HTMLElement).getByText('En cours')).toBeInTheDocument()
    expect(within(cards[0] as HTMLElement).getByText('12 entrées')).toBeInTheDocument()
    expect(within(cards[0] as HTMLElement).getByText('il y a 30 min')).toBeInTheDocument()
    expect(within(cards[0] as HTMLElement).getByText('il y a 2 min')).toBeInTheDocument()
    expect(within(cards[1] as HTMLElement).getByText('Terminée')).toBeInTheDocument()
    expect(within(cards[1] as HTMLElement).getByText('Exécution terminée')).toBeInTheDocument()
    expect(within(cards[1] as HTMLElement).getByText('Aucune entrée')).toBeInTheDocument()
    expect(screen.getByText('1 agent en cours sur 2 sessions')).toBeInTheDocument()
  })

  it('shows a visible warning with the reason for a timed-out session', async () => {
    stubApi(
      api(
        [
          200,
          sessionsPage([
            session({
              status: 'timed_out',
              disconnect_reason: 'inactivity_timeout',
              ended_at: ago(1),
            }),
          ]),
        ],
        [200, { items: [], next_cursor: null }],
      ),
    )
    renderApp(PATH)

    expect(await screen.findByText('Expirée')).toBeInTheDocument()
    expect(screen.getByText(/Session expirée : Aucune activité pendant 3 h/)).toBeInTheDocument()
    expect(screen.getByText(/déconnecté avant d’avoir terminé/)).toBeInTheDocument()
  })

  it('renders factual entries with type badge, source link, publication date and no invented date', async () => {
    stubApi(
      api(
        [200, sessionsPage([session()])],
        [
          200,
          {
            items: [
              entry({
                id: 'l2',
                event_type: 'source_opened',
                message: 'Page À propos ouverte.',
                source_url: 'https://exemple.fr/a-propos',
                source_published_at: '2026-03-04',
                task_id: 't1',
              }),
              entry({
                id: 'l3',
                event_type: 'verification',
                message: 'SIREN confirmé.',
                source_url: 'https://registre.example/siren',
              }),
              entry({
                id: 'l4',
                event_type: 'error',
                message: 'Source injoignable.',
                source_url: 'javascript:alert(1)',
              }),
            ],
            next_cursor: null,
          },
        ],
      ),
    )
    renderApp(PATH)

    const log = await screen.findByRole('list', {
      name: /Journal d’activité, du plus récent/,
    })
    const rows = within(log).getAllByRole('listitem')
    expect(rows).toHaveLength(3)
    const first = rows[0] as HTMLElement
    expect(within(first).getByText('Source ouverte')).toBeInTheDocument()
    expect(within(first).getByText('Page À propos ouverte.')).toBeInTheDocument()
    const link = within(first).getByRole('link', { name: /exemple\.fr/ })
    expect(link).toHaveAttribute('href', 'https://exemple.fr/a-propos')
    expect(link).toHaveAttribute('target', '_blank')
    expect(link).toHaveAttribute('rel', expect.stringContaining('noopener'))
    expect(within(first).getByText('Publiée le 4 mars 2026')).toBeInTheDocument()
    expect(within(rows[1] as HTMLElement).getByText('Date de publication inconnue')).toBeInTheDocument()
    // Unsafe scheme: shown as text, never clickable.
    expect(within(rows[2] as HTMLElement).queryByRole('link')).not.toBeInTheDocument()
    expect(within(rows[2] as HTMLElement).getByText('Erreur')).toBeInTheDocument()
  })

  it('never uses reasoning vocabulary', async () => {
    stubApi(api([200, sessionsPage([session()])], [200, { items: [entry()], next_cursor: null }]))
    const { container } = renderApp(PATH)
    await screen.findByText('Recherche du SIREN de Transports X.')
    expect(container.textContent).not.toMatch(/raisonnement|pensée|chain[- ]of[- ]thought|réflexion/i)
  })

  it('sends filters to the API: event types, agent, session, then resets', async () => {
    const calls: URL[] = []
    stubApi(
      api(
        [
          200,
          sessionsPage([
            session(),
            session({
              id: 's2',
              agent_id: 'a2',
              agent_label: 'Agent claude-02',
            }),
          ]),
        ],
        (url) => {
          calls.push(url)
          return [200, { items: [entry()], next_cursor: null }]
        },
      ),
    )
    const user = userEvent.setup()
    renderApp(PATH)
    await screen.findByText('Recherche du SIREN de Transports X.')
    expect(calls[0]?.search).toBe('?limit=50')

    await user.click(screen.getByRole('button', { name: 'Vérification' }))
    await user.click(screen.getByRole('button', { name: 'Erreur' }))
    expect(screen.getByRole('button', { name: 'Erreur' })).toHaveAttribute('aria-pressed', 'true')
    await waitFor(() => {
      expect(calls.at(-1)?.searchParams.getAll('event_type')).toEqual(['verification', 'error'])
    })

    await user.selectOptions(screen.getByLabelText('Agent'), 'a2')
    await waitFor(() => {
      expect(calls.at(-1)?.searchParams.get('agent_id')).toBe('a2')
    })
    // Sessions list narrows to the chosen agent.
    const list = screen.getByRole('list', { name: 'Sessions des agents' })
    expect(within(list).getAllByRole('listitem')).toHaveLength(1)

    await user.selectOptions(screen.getByLabelText('Exécution'), RUN)
    await waitFor(() => {
      expect(calls.at(-1)?.searchParams.get('run_id')).toBe(RUN)
    })

    await user.click(
      screen.getByRole('button', {
        name: 'Filtrer le journal de Agent claude-02',
      }),
    )
    await waitFor(() => {
      expect(calls.at(-1)?.searchParams.get('session_id')).toBe('s2')
    })

    await user.click(screen.getByRole('button', { name: 'Réinitialiser les filtres' }))
    await waitFor(() => {
      expect(calls.at(-1)?.search).toBe('?limit=50')
    })
    expect(screen.getByLabelText('Agent')).toHaveValue('')
  })

  it('filters the log by task from an entry', async () => {
    const calls: URL[] = []
    stubApi(
      api([200, sessionsPage([session()])], (url) => {
        calls.push(url)
        return [200, { items: [entry({ task_id: 'task-9' })], next_cursor: null }]
      }),
    )
    const user = userEvent.setup()
    renderApp(PATH)
    await user.click(await screen.findByRole('button', { name: /Journal de la tâche/ }))
    await waitFor(() => {
      expect(calls.at(-1)?.searchParams.get('task_id')).toBe('task-9')
    })
    await user.click(screen.getByRole('button', { name: 'Retirer le filtre tâche' }))
    await waitFor(() => {
      expect(calls.at(-1)?.searchParams.get('task_id')).toBeNull()
    })
  })

  it('loads older entries with the cursor and drops duplicates', async () => {
    const calls: URL[] = []
    stubApi(
      api([200, sessionsPage([session()])], (url) => {
        calls.push(url)
        const before = url.searchParams.get('before')
        if (!before) {
          return [
            200,
            {
              items: [entry({ id: 'l9', message: 'Plus récent' }), entry({ id: 'l8', message: 'Milieu' })],
              next_cursor: 'l8',
            },
          ]
        }
        return [
          200,
          {
            items: [entry({ id: 'l8', message: 'Milieu' }), entry({ id: 'l7', message: 'Ancien' })],
            next_cursor: null,
          },
        ]
      }),
    )
    const user = userEvent.setup()
    renderApp(PATH)
    await screen.findByText('Plus récent')
    await user.click(
      screen.getByRole('button', {
        name: 'Charger les entrées plus anciennes',
      }),
    )

    expect(await screen.findByText('Ancien')).toBeInTheDocument()
    expect(calls.at(-1)?.searchParams.get('before')).toBe('l8')
    expect(screen.getAllByText('Milieu')).toHaveLength(1)
    expect(
      screen.queryByRole('button', {
        name: 'Charger les entrées plus anciennes',
      }),
    ).not.toBeInTheDocument()
  })

  it('shows an honest empty state when no agent ever worked', async () => {
    stubApi(api([200, sessionsPage([])], [200, { items: [], next_cursor: null }]))
    renderApp(PATH)
    expect(
      await screen.findByText(/Aucun agent n’a encore travaillé/, {
        selector: 'p.activity-state',
      }),
    ).toBeInTheDocument()
    expect(await screen.findByText(/elles apparaîtront dès qu’un agent journalise/)).toBeInTheDocument()
  })

  it('says when filters match nothing', async () => {
    stubApi(
      api([200, sessionsPage([session()])], (url) => [
        200,
        {
          items: url.searchParams.has('event_type') ? [] : [entry()],
          next_cursor: null,
        },
      ]),
    )
    const user = userEvent.setup()
    renderApp(PATH)
    await screen.findByText('Recherche du SIREN de Transports X.')
    await user.click(screen.getByRole('button', { name: 'Alerte' }))
    expect(await screen.findByText('Aucune entrée ne correspond à ces filtres.')).toBeInTheDocument()
  })

  it('shows errors with a retry for sessions and log', async () => {
    let healthy = false
    stubApi(
      api(
        () => (healthy ? [200, sessionsPage([session()])] : [500, { detail: 'boom' }]),
        () => (healthy ? [200, { items: [entry()], next_cursor: null }] : [500, { detail: 'boom' }]),
      ),
    )
    const user = userEvent.setup()
    renderApp(PATH)

    expect(await screen.findByText('Les sessions des agents sont indisponibles.')).toBeInTheDocument()
    expect(await screen.findByText('Le journal d’activité est indisponible.')).toBeInTheDocument()

    healthy = true
    const sessionsError = screen.getByText('Les sessions des agents sont indisponibles.').closest('div') as HTMLElement
    await user.click(within(sessionsError).getByRole('button', { name: 'Réessayer' }))
    expect(await screen.findByRole('list', { name: 'Sessions des agents' })).toBeInTheDocument()
  })

  it('shows loading states before data arrives', async () => {
    stubApi(
      api(
        () => new Promise<Response>(() => undefined),
        () => new Promise<Response>(() => undefined),
      ),
    )
    renderApp(PATH)
    expect(await screen.findByText('Chargement des sessions…')).toBeInTheDocument()
    expect(screen.getByText('Chargement du journal…')).toBeInTheDocument()
  })
})
