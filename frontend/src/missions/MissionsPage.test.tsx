import { screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'

import type { ResultView } from '../api/agents'
import { SHELL_API } from '../test/homeApi'
import { type ApiReply, renderApp, stubApi } from '../test/render'
import { card, COMMON, COMPANY, detail, MISSION } from './missionTestData'

describe('MissionsPage', () => {
  it('shows the mission, its agent, its recurrence and the results to review', async () => {
    stubApi({
      ...SHELL_API,
      ...COMMON,
      'GET /api/missions': [200, { items: [card()], total: 1 }],
    })

    renderApp('/missions')

    expect(screen.getByRole('heading', { level: 1, name: 'Missions' })).toBeInTheDocument()
    expect(await screen.findByText('Nouveaux entrepôts — Normandie')).toBeInTheDocument()
    const title = screen.getByRole('link', { name: /Nouveaux entrepôts/ })
    expect(title).toHaveAttribute('href', `/missions/${MISSION}`)
    const link = screen.getByRole('article')
    expect(within(link).getByText('Enrichissement')).toBeInTheDocument()
    expect(within(link).getByText('Agent claude-01')).toBeInTheDocument()
    expect(within(link).getByText('Toutes les 24 heures')).toBeInTheDocument()
    // « à relire » and « à valider » are one link each, straight to the mission's Résultats tab (not nested in the title link).
    const toReview = within(link).getAllByRole('link', { name: /1 à valider : ouvrir les résultats/ })
    expect(toReview).toHaveLength(2)
    for (const anchor of toReview) expect(anchor).toHaveAttribute('href', `/missions/${MISSION}?tab=results`)
    expect(within(link).getByText('1 à relire')).toBeInTheDocument()
    expect(within(link).getByText('1 à valider')).toBeInTheDocument()
    expect(title).not.toContainElement(toReview[0] ?? null)
    expect(within(link).getByText('1 tâche')).toBeInTheDocument()
    // 0 of 1 task accepted: a real 0 %, with a labelled bar.
    expect(within(link).getByRole('progressbar', { name: 'Progression : 0 % des tâches validées' })).toBeInTheDocument()
  })

  it('lists the agents working now with their person, three at most, and nothing when none is active', async () => {
    const agents = ['ChatGPT', 'Claude', 'Gemini', 'Mistral', 'Grok'].map((label, index) => ({
      agent_id: `a${String(index)}`,
      agent_label: label,
      owner_name: index === 0 ? 'Etienne Debazelaire' : null,
    }))
    stubApi({
      ...SHELL_API,
      ...COMMON,
      'GET /api/missions': [
        200,
        { items: [card({ live_agents: agents }), card({ id: 'idle', name: 'Mission calme', live_agents: [] })], total: 2 },
      ],
    })

    renderApp('/missions')

    const busy = (await screen.findAllByRole('article'))[0] as HTMLElement
    const live = within(busy).getByRole('list', { name: 'Agents au travail' })
    expect(within(live).getByText('ED')).toBeInTheDocument()
    expect(within(live).getByText('ChatGPT')).toBeInTheDocument()
    expect(within(live).queryByText('Mistral')).not.toBeInTheDocument()
    expect(within(live).getByText('+2')).toBeInTheDocument()
    expect(screen.getAllByRole('list', { name: 'Agents au travail' })).toHaveLength(1)
  })

  it('pins the permanent Dépôt first, with no switch and no menu', async () => {
    const deposit = card({
      id: 'deposit',
      name: 'Dépôt',
      is_deposit: true,
      category: null,
      agent_label: null,
      runs_count: 2,
      tasks_total: 2,
      results_pending: 1,
    })
    stubApi({
      ...SHELL_API,
      ...COMMON,
      'GET /api/missions': [200, { items: [card(), deposit], total: 2 }],
    })

    renderApp('/missions')

    await screen.findByRole('link', { name: 'Dépôt' })
    const link = screen.getAllByRole('article')[0] as HTMLElement
    expect(within(link).getByText('Permanente')).toBeInTheDocument()
    expect(within(link).getByText('2 dépôts')).toBeInTheDocument()
    expect(screen.queryByRole('switch', { name: 'Mission Dépôt active' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Actions de la mission Dépôt' })).not.toBeInTheDocument()
    // The ordinary mission keeps both.
    expect(screen.getByRole('button', { name: /Actions de la mission Nouveaux entrepôts/ })).toBeInTheDocument()
    // Pinned first, whatever the sort.
    const titles = screen.getAllByRole('heading', { level: 2 }).map((heading) => heading.textContent)
    expect(titles.indexOf('Dépôt')).toBeLessThan(titles.indexOf('Nouveaux entrepôts — Normandie'))
  })

  it('counts the whole list in the header tiles, whatever the filters', async () => {
    const other = card({ id: 'other', name: 'Veille', type: 'signals', status: 'paused', agent_label: null, tasks_total: 0, results_pending: 0 })
    const done = card({ id: 'done', name: 'Close', status: 'done' })
    stubApi({
      ...SHELL_API,
      ...COMMON,
      'GET /api/missions': [200, { items: [card(), other, done], total: 3 }],
    })
    const user = userEvent.setup()
    renderApp('/missions')

    await screen.findByText('Veille')
    // The tile of « Toutes les missions »: a <dt> label and its figure.
    const total = () => document.querySelector('.mui-kpi')
    const counters = total()
    expect(counters).toHaveTextContent('3')
    expect(screen.getByText('Automatique')).toBeInTheDocument()
    expect(screen.getByText('Aucune tâche')).toBeInTheDocument()

    await user.selectOptions(screen.getByRole('combobox', { name: 'Statut' }), 'paused')
    expect(screen.queryByText('Nouveaux entrepôts — Normandie')).not.toBeInTheDocument()
    expect(screen.getByText('Veille')).toBeInTheDocument()
    expect(total()).toHaveTextContent('3')

    await user.selectOptions(screen.getByRole('combobox', { name: 'Type' }), 'prospection')
    expect(await screen.findByText('Aucune mission ne correspond à ces filtres.')).toBeInTheDocument()
    await user.click(screen.getAllByRole('button', { name: 'Réinitialiser les filtres' })[0] as HTMLElement)
    expect(await screen.findByText('Nouveaux entrepôts — Normandie')).toBeInTheDocument()
  })

  it('counts every result waiting for review: the missions’ own and the proposals outside any mission', async () => {
    stubApi({
      ...SHELL_API,
      ...COMMON,
      'GET /api/missions': [200, { items: [card({ results_pending: 3 }), card({ id: 'b', name: 'Veille', results_pending: 1 })], total: 2 }],
      'GET /api/missions/proposals': [
        200,
        [
          {
            result_id: '00000000-0000-7000-e000-0000000000aa',
            task_type: 'update_company',
            submitted_by_label: 'Agent claude-01',
            submitted_at: '2026-10-30T08:05:00+00:00',
            subject_label: 'Transports X',
          },
        ],
      ],
    })
    renderApp('/missions')

    await screen.findByText('Veille')
    const tile = await screen.findByText('En attente de relecture')
    expect(tile.closest('.mui-kpi')).toHaveTextContent('5')
  })

  it('says why the list is missing and retries', async () => {
    stubApi({ ...SHELL_API, ...COMMON, 'GET /api/missions': [500, { detail: 'boom' }] })
    renderApp('/missions')

    expect(await screen.findByRole('alert')).toHaveTextContent('Les missions n’ont pas pu être chargées.')
    expect(screen.getByRole('button', { name: 'Réessayer' })).toBeInTheDocument()
  })

  async function openCreate() {
    stubApi({
      ...SHELL_API,
      ...COMMON,
      'GET /api/missions': [200, { items: [], total: 0 }],
    })
    const user = userEvent.setup()
    renderApp('/missions')
    const [firstCreate] = await screen.findAllByRole('button', { name: 'Nouvelle mission' })
    expect(firstCreate).toBeDefined()
    await user.click(firstCreate as HTMLElement)
    return { user, dialog: await screen.findByRole('dialog', { name: 'Créer mission' }) }
  }

  // The type is chosen in a picker that opens over the form and closes on the choice.
  async function pickCategory(user: ReturnType<typeof userEvent.setup>, dialog: HTMLElement, name: string) {
    await user.click(await within(dialog).findByRole('button', { name: /^Type de mission/ }))
    await user.click(await screen.findByRole('radio', { name }))
  }

  function postedBody(fetchMock: ReturnType<typeof stubApi>) {
    const [, init] =
      fetchMock.mock.calls.find(([url, request]) => url.endsWith('/api/missions') && request?.method === 'POST') ?? []
    return JSON.parse(init?.body as string) as Record<string, unknown>
  }

  async function openCreateWith(replies: Record<string, ApiReply> = {}) {
    const fetchMock = stubApi({
      ...SHELL_API,
      ...COMMON,
      'GET /api/missions': [200, { items: [], total: 0 }],
      'POST /api/missions': [201, detail()],
      [`GET /api/missions/${MISSION}`]: [200, detail()],
      ...replies,
    })
    const user = userEvent.setup()
    renderApp('/missions')
    await user.click((await screen.findAllByRole('button', { name: 'Nouvelle mission' }))[0] as HTMLElement)
    const dialog = await screen.findByRole('dialog', { name: 'Créer mission' })
    return { fetchMock, user, dialog }
  }

  it('suggests a name from the consigne and says what is missing before saving', async () => {
    const { user, dialog } = await openCreate()

    await user.type(within(dialog).getByLabelText(/Consigne/), 'Trouve les commissaires au transport en Normandie')

    expect(within(dialog).getByLabelText(/Titre de la mission/)).toHaveValue('Trouve les commissaires au transport en Normandie')
    // « Enrichissement » by default: no linked record is required, the mission is ready at once.
    expect(await within(dialog).findByRole('button', { name: 'Type de mission Enrichissement' })).toBeInTheDocument()
    expect(within(dialog).queryByRole('status')).not.toBeInTheDocument()
    expect(within(dialog).getByRole('button', { name: 'Créer la mission' })).toBeEnabled()

    await pickCategory(user, dialog, 'Prospection')
    expect(within(dialog).getByRole('combobox', { name: 'Résultat attendu' })).toHaveDisplayValue('Découvrir des sociétés')
    expect(within(dialog).queryByRole('status')).not.toBeInTheDocument()
    expect(within(dialog).getByRole('button', { name: 'Créer la mission' })).toBeEnabled()
  })

  it('follows the category until the person overrides: null prompt, skills and sources are sent to inherit', async () => {
    const { fetchMock, user, dialog } = await openCreateWith()
    await user.type(within(dialog).getByLabelText(/^Titre de la mission/), 'Découverte Normandie')
    await pickCategory(user, dialog, 'Prospection')
    // The category's general prompt is the placeholder of the empty consigne.
    expect(within(dialog).getByRole('textbox', { name: 'Consigne' })).toHaveAttribute('placeholder', 'Consigne générale : Prospection.')

    await user.click(within(dialog).getByRole('button', { name: 'Créer la mission' }))

    expect(postedBody(fetchMock)).toMatchObject({
      category_id: 'cat-prospection',
      type: 'prospection',
      prompt: null,
      skill_ids: null,
      source_ids: null,
      allow_multiple: false,
      objective: { kind: 'tasks_accepted', count: null },
    })
  })

  it('sends own values once overridden, and goes back to the category with the reset button', async () => {
    const { fetchMock, user, dialog } = await openCreateWith()
    await pickCategory(user, dialog, 'Prospection')
    await user.type(within(dialog).getByLabelText(/Consigne/), 'Cherche des transporteurs')
    await user.click(within(dialog).getByRole('button', { name: /Skills/ }))
    expect(within(dialog).getByText('Suit la catégorie « Prospection ».')).toBeInTheDocument()
    await user.click(within(dialog).getByRole('button', { name: 'Personnaliser les skills' }))
    await user.click(await within(dialog).findByRole('checkbox', { name: /Sources fiables/ }))
    await user.click(within(dialog).getByRole('button', { name: /Sources/ }))
    await user.click(within(dialog).getByRole('button', { name: 'Personnaliser les sources' }))
    await user.click(within(dialog).getByRole('button', { name: 'Revenir aux sources de la catégorie' }))

    await user.click(within(dialog).getByRole('button', { name: 'Créer la mission' }))

    expect(postedBody(fetchMock)).toMatchObject({
      prompt: 'Cherche des transporteurs',
      skill_ids: ['skill-1'],
      source_ids: null,
    })
  })

  it('saves a link under Sources and uses it in the mission', async () => {
    const saved = { id: 'source-9', url: 'https://www.example.com/annuaire', label: null, missions_count: 0 }
    const { fetchMock, user, dialog } = await openCreateWith({ 'POST /api/missions/sources': [201, saved] })
    await user.type(within(dialog).getByLabelText(/Consigne/), 'Trouve des transporteurs')
    await pickCategory(user, dialog, 'Prospection')

    await user.click(within(dialog).getByRole('button', { name: /Sources/ }))
    await user.click(within(dialog).getByRole('button', { name: 'Personnaliser les sources' }))
    await user.type(within(dialog).getByLabelText('Nouveau lien'), 'https://www.example.com/annuaire')
    await user.click(within(dialog).getByRole('button', { name: 'Enregistrer le lien' }))
    await user.click(within(dialog).getByRole('button', { name: 'Créer la mission' }))

    expect(postedBody(fetchMock)).toMatchObject({ source_ids: ['source-9'] })
  })

  it('links internal context apart from the targets, and sends the objective and one-item mode', async () => {
    const { fetchMock, user, dialog } = await openCreateWith({
      'GET /api/missions/context-candidates': [200, [{ kind: 'company', id: COMPANY, label: 'Transports X', hint: 'Rouen' }]],
    })
    await user.type(within(dialog).getByLabelText(/Consigne/), 'Trouve des transporteurs')
    await pickCategory(user, dialog, 'Prospection')
    await user.click(within(dialog).getByRole('button', { name: /Sources/ }))
    await user.click(within(dialog).getByRole('button', { name: 'Ajouter du contexte' }))
    const picker = await screen.findByRole('dialog', { name: 'Ajouter du contexte VIPER' })
    await user.click(await within(picker).findByRole('checkbox', { name: /Transports X/ }))
    await user.click(within(picker).getByRole('button', { name: /Ajouter \(1\)/ }))
    await user.selectOptions(within(dialog).getByRole('combobox', { name: 'Objectif' }), 'Un nombre d’éléments validés')
    await user.clear(within(dialog).getByLabelText('Éléments à valider'))
    await user.type(within(dialog).getByLabelText('Éléments à valider'), '5')
    await user.click(within(dialog).getByRole('checkbox', { name: /Plusieurs éléments/ }))

    await user.click(within(dialog).getByRole('button', { name: 'Créer la mission' }))

    expect(postedBody(fetchMock)).toMatchObject({
      targets: [],
      context_refs: [{ kind: 'company', id: COMPANY, note: null }],
      objective: { kind: 'accepted_items', count: 5 },
      allow_multiple: true,
    })
  })

  it('allows an objective above the per-run limit', async () => {
    const { user, dialog } = await openCreate()
    await user.type(within(dialog).getByLabelText(/Consigne/), 'Trouve des transporteurs')
    await pickCategory(user, dialog, 'Prospection')
    await user.selectOptions(within(dialog).getByRole('combobox', { name: 'Objectif' }), 'Un nombre d’éléments validés')
    await user.clear(within(dialog).getByLabelText('Éléments à valider'))
    await user.type(within(dialog).getByLabelText('Éléments à valider'), '50')

    expect(within(dialog).queryByRole('status')).not.toBeInTheDocument()
    expect(within(dialog).getByRole('button', { name: 'Créer la mission' })).toBeEnabled()
  })

  it('does not require a linked record for a signals mission', async () => {
    const { user, dialog } = await openCreate()
    await user.type(within(dialog).getByLabelText(/Consigne/), 'Nouveaux entrepôts en Normandie')

    await pickCategory(user, dialog, 'Signaux')

    expect(within(dialog).queryByRole('status')).not.toBeInTheDocument()
    expect(within(dialog).getByRole('button', { name: 'Créer la mission' })).toBeEnabled()
  })

  it('shows an inline error and retries when the categories cannot be loaded', async () => {
    const { dialog } = await openCreateWith({ 'GET /api/mission-categories': [500, { detail: 'boom' }] })

    expect(await within(dialog).findByText(/catégories n’ont pas pu être chargées/)).toBeInTheDocument()
    expect(within(dialog).getByRole('button', { name: 'Réessayer' })).toBeInTheDocument()
    expect(within(dialog).getByRole('button', { name: 'Créer la mission' })).toBeDisabled()
  })

  it('activates an inactive mission from the switch on its card', async () => {
    const fetchMock = stubApi({
      ...SHELL_API,
      ...COMMON,
      'GET /api/missions': [200, { items: [card({ status: 'paused', next_run_at: null })], total: 1 }],
      [`PATCH /api/missions/${MISSION}`]: [200, detail()],
    })
    const user = userEvent.setup()
    renderApp('/missions')

    expect(await screen.findByText('Inactive : fermée aux agents')).toBeInTheDocument()
    const toggle = screen.getByRole('switch', { name: 'Mission Nouveaux entrepôts — Normandie active' })
    expect(toggle).not.toBeChecked()
    await user.click(toggle)

    const patch = fetchMock.mock.calls.find(([, init]) => init?.method === 'PATCH')?.[1]?.body
    expect(typeof patch === 'string' ? JSON.parse(patch) : null).toEqual({ status: 'active' })
  })
})

describe('the mission menu (right-click on a card)', () => {
  function stubList(extra: Record<string, ApiReply> = {}) {
    let deleted = false
    const fetchMock = stubApi({
      ...SHELL_API,
      ...COMMON,
      'GET /api/missions': () => [200, deleted ? { items: [], total: 0 } : { items: [card()], total: 1 }],
      [`GET /api/missions/${MISSION}`]: [200, detail()],
      [`DELETE /api/missions/${MISSION}`]: () => {
        deleted = true
        return [204]
      },
      [`PUT /api/missions/${MISSION}`]: [200, { ...detail(), card: card({ name: 'Entrepôts — Normandie et Bretagne' }) }],
      ...extra,
    })
    return {
      fetchMock,
      get deleted() {
        return deleted
      },
      // The body of the `PUT` (« Enregistrer »), or null.
      get saved(): Record<string, unknown> | null {
        const body = fetchMock.mock.calls.find(([, init]) => init?.method === 'PUT')?.[1]?.body
        return typeof body === 'string' ? (JSON.parse(body) as Record<string, unknown>) : null
      },
    }
  }

  it('opens on a right-click and deletes the mission after a confirmation', async () => {
    const api = stubList()
    const user = userEvent.setup()
    renderApp('/missions')

    const tile = await screen.findByRole('link', { name: /Nouveaux entrepôts/ })
    await user.pointer({ keys: '[MouseRight]', target: tile })
    const menu = await screen.findByRole('menu', { name: 'Actions de la mission Nouveaux entrepôts — Normandie' })
    expect(within(menu).getAllByRole('menuitem').map((item) => item.textContent)).toEqual(['Ouvrir', 'Modifier…', 'Supprimer…'])
    await user.click(within(menu).getByRole('menuitem', { name: 'Supprimer…' }))
    await user.click(within(await screen.findByRole('dialog', { name: 'Supprimer cette mission ?' })).getByRole('button', { name: 'Supprimer la mission' }))

    expect(await screen.findByText('Aucune mission')).toBeInTheDocument()
    expect(api.deleted).toBe(true)
  })

  it('edits the mission from the « … » button, prefilled with its rule', async () => {
    const api = stubList()
    const user = userEvent.setup()
    renderApp('/missions')

    await user.click(await screen.findByRole('button', { name: 'Actions de la mission Nouveaux entrepôts — Normandie' }))
    await user.click(within(await screen.findByRole('menu')).getByRole('menuitem', { name: 'Modifier…' }))
    const dialog = await screen.findByRole('dialog', { name: 'Modifier la mission' })
    const name = within(dialog).getByRole('textbox', { name: 'Titre de la mission' })
    expect(name).toHaveValue('Nouveaux entrepôts — Normandie')
    expect(within(dialog).getByRole('textbox', { name: 'Consigne' })).toHaveValue(
      'Complète ces fiches avec le site web et le domaine e-mail.',
    )
    await user.click(within(dialog).getByRole('button', { name: /Sources/ }))
    expect(within(dialog).queryByText('Données liées')).not.toBeInTheDocument()
    await user.clear(name)
    await user.type(name, 'Entrepôts — Normandie et Bretagne')
    await user.click(within(dialog).getByRole('button', { name: 'Enregistrer' }))

    await screen.findByRole('link', { name: /Nouveaux entrepôts/ })
    expect(screen.queryByRole('dialog', { name: 'Modifier la mission' })).not.toBeInTheDocument()
    const body = api.saved ?? {}
    expect(body.name).toBe('Entrepôts — Normandie et Bretagne')
    expect(body.targets).toEqual([{ kind: 'company', id: COMPANY }])
    expect(body.is_recurring).toBe(true)
    expect(body.interval_count).toBe(24)
    expect(body.geography).toBe('Normandie')
    expect(body.run_now).toBe(false)
  })

  it('does not offer to edit a finished mission', async () => {
    stubList({ 'GET /api/missions': [200, { items: [card({ status: 'done' })], total: 1 }] })
    const user = userEvent.setup()
    renderApp('/missions')

    await user.pointer({ keys: '[MouseRight]', target: await screen.findByRole('link', { name: /Nouveaux entrepôts/ }) })
    expect(within(await screen.findByRole('menu')).getByRole('menuitem', { name: 'Modifier…' })).toBeDisabled()
  })
})

describe('MissionDetailPage', () => {
  it('shows the consigne, the linked record, the run and the review button', async () => {
    stubApi({
      ...SHELL_API,
      ...COMMON,
      [`GET /api/missions/${MISSION}`]: [200, detail()],
    })

    renderApp(`/missions/${MISSION}`)

    expect(await screen.findByRole('heading', { level: 1, name: 'Nouveaux entrepôts — Normandie' })).toBeInTheDocument()
    expect(screen.getByText(/Complète ces fiches avec le site web/)).toBeInTheDocument()
    expect(screen.getByText('Transports X')).toBeInTheDocument()
    expect(screen.getByText(/1 tâche · 1 résultat/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Relire' })).toBeInTheDocument()
  })

  it('says why the last run failed and that an inactive mission is closed to the agents', async () => {
    const mission = detail()
    mission.card = card({ status: 'paused', next_run_at: null })
    const [firstRun] = mission.runs
    if (firstRun) {
      firstRun.status = 'failed'
      firstRun.note = 'Liez au moins une société à surveiller.'
    }
    stubApi({ ...SHELL_API, ...COMMON, [`GET /api/missions/${MISSION}`]: [200, mission] })

    renderApp(`/missions/${MISSION}`)

    expect(await screen.findByText(/ne sont plus proposées aux agents/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Activer' })).toBeInTheDocument()
    expect(screen.getByText(/Dernière exécution en échec : Liez au moins une société/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Lancer maintenant' })).not.toBeInTheDocument()
  })

  it('deletes the mission after a confirmation and goes back to the list', async () => {
    let deleted = false
    const fetchMock = stubApi({
      ...SHELL_API,
      ...COMMON,
      [`GET /api/missions/${MISSION}`]: [200, detail()],
      [`DELETE /api/missions/${MISSION}`]: () => {
        deleted = true
        return [204]
      },
      'GET /api/missions': () => [200, deleted ? { items: [], total: 0 } : { items: [card()], total: 1 }],
    })
    const user = userEvent.setup()

    renderApp(`/missions/${MISSION}`)
    await user.click(await screen.findByRole('button', { name: 'Supprimer' }))
    const dialog = await screen.findByRole('dialog', { name: 'Supprimer cette mission ?' })
    expect(dialog).toHaveTextContent(/Les tâches encore en attente, en cours ou à relire sont annulées/)
    // « Retour » sends nothing.
    await user.click(within(dialog).getByRole('button', { name: 'Retour' }))
    expect(deleted).toBe(false)

    await user.click(screen.getByRole('button', { name: 'Supprimer' }))
    await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Supprimer la mission' }))

    expect(await screen.findByRole('heading', { level: 1, name: 'Missions' })).toBeInTheDocument()
    expect(deleted).toBe(true)
    expect(fetchMock.mock.calls.filter(([, init]) => init?.method === 'DELETE')).toHaveLength(1)
  })

  it('says when the deletion failed and keeps the mission open', async () => {
    stubApi({
      ...SHELL_API,
      ...COMMON,
      [`GET /api/missions/${MISSION}`]: [200, detail()],
      [`DELETE /api/missions/${MISSION}`]: [500, { detail: 'boom' }],
    })
    const user = userEvent.setup()

    renderApp(`/missions/${MISSION}`)
    await user.click(await screen.findByRole('button', { name: 'Supprimer' }))
    await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Supprimer la mission' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('La mission n’a pas pu être supprimée')
    expect(screen.getByRole('heading', { level: 1, name: 'Nouveaux entrepôts — Normandie' })).toBeInTheDocument()
  })
})


describe('Signal review', () => {
  it('shows the signal board: kind, subject, date, score and source', async () => {
    const result: ResultView = {
      id: '00000000-0000-7000-e000-000000000040',
      task_id: '00000000-0000-7000-e000-000000000030',
      task_type: 'surveil_signals',
      task_status: 'submitted',
      status: 'pending_review',
      submitted_at: '2026-10-30T08:05:00+00:00',
      submitted_by_label: 'Agent claude-01',
      digest: 'a'.repeat(64),
      raw: {},
      proposal: {
        kind: 'signals',
        items: [
          {
            key: 'signal:0',
            field: 'signals.0',
            label: '2SN — hiring',
            before: null,
            after: '2SN recrute son premier responsable commercial.',
            status: 'add',
            source: 'https://example.test/2sn',
            quote: 'Un premier commercial annonce un budget outillage.',
            store: {
              kind: 'hiring',
              subject: '2SN',
              observed_on: '2026-10-25',
              score_delta: 15,
              relevance: 80,
            },
          },
        ],
        refused: [],
        stale: false,
        confidence: 80,
        notes: null,
      },
      accepted_items: null,
      applied: null,
      decision_note: null,
      decided_at: null,
      decided_by_display: null,
      company_name: '2SN',
      prospect_name: null,
    }
    const mission = detail()
    const firstTask = mission.tasks[0]
    expect(firstTask).toBeDefined()
    if (firstTask) firstTask.result_id = result.id
    stubApi({
      ...SHELL_API,
      ...COMMON,
      [`GET /api/missions/${MISSION}`]: [200, mission],
      [`GET /api/agents/results/${result.id}`]: [200, result],
    })
    const user = userEvent.setup()

    renderApp(`/missions/${MISSION}`)
    await user.click(await screen.findByRole('button', { name: 'Relire' }))

    expect(await screen.findByText('Recrutement')).toBeInTheDocument()
    expect(screen.getAllByText('2SN').length).toBeGreaterThan(0)
    expect(screen.getByText('2SN recrute son premier responsable commercial.')).toBeInTheDocument()
    expect(screen.getByText('2026-10-25')).toBeInTheDocument()
    expect(screen.getByText('+15')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'example.test/2sn' })).toHaveAttribute(
      'href',
      'https://example.test/2sn',
    )
  })

  it('shows a discovered company with its sites and its trigger', async () => {
    const result: ResultView = {
      id: '00000000-0000-7000-e000-000000000041',
      task_id: '00000000-0000-7000-e000-000000000030',
      task_type: 'find_prospects',
      task_status: 'submitted',
      status: 'pending_review',
      submitted_at: '2026-10-30T08:05:00+00:00',
      submitted_by_label: 'Agent découverte',
      digest: 'b'.repeat(64),
      raw: { companies: [{ display_name: 'Logistique Y' }] },
      proposal: {
        kind: 'find_prospects',
        items: [
          {
            key: 'company:0:logistique y',
            field: 'companies.0',
            label: 'Logistique Y',
            before: null,
            after: 'Nouvelle société',
            status: 'add',
            source: 'https://annuaire.example/logistique-y',
            quote: null,
            store: {
              display_name: 'Logistique Y',
              establishments: [
                {
                  name: 'Plateforme de Honfleur',
                  kind: 'entrepôt',
                  siret: '73282932010008',
                  postal_code: '14600',
                  city: 'Honfleur',
                  opened_on: '2026-09-12',
                  surface_m2: 18000,
                  source: 'https://presse.example/honfleur',
                },
              ],
              trigger: {
                kind: 'facility_opening',
                signal: 'Ouverture d’un nouvel entrepôt de 18 000 m².',
                score_delta: 20,
                score_reason: 'Nouvelle implantation logistique.',
                source_url: 'https://presse.example/honfleur',
                observed_on: '2026-09-12',
              },
            },
          },
        ],
        refused: [],
        stale: false,
        confidence: 80,
        notes: null,
      },
      accepted_items: null,
      applied: null,
      decision_note: null,
      decided_at: null,
      decided_by_display: null,
      company_name: null,
      prospect_name: null,
    }
    const mission = detail()
    const firstTask = mission.tasks[0]
    expect(firstTask).toBeDefined()
    if (firstTask) firstTask.result_id = result.id
    stubApi({
      ...SHELL_API,
      ...COMMON,
      [`GET /api/missions/${MISSION}`]: [200, mission],
      [`GET /api/agents/results/${result.id}`]: [200, result],
    })
    const user = userEvent.setup()

    renderApp(`/missions/${MISSION}`)
    await user.click(await screen.findByRole('button', { name: 'Relire' }))

    const sites = await screen.findByRole('list', { name: 'Établissements' })
    expect(within(sites).getByText('Plateforme de Honfleur')).toBeInTheDocument()
    expect(within(sites).getByText('14600 Honfleur')).toBeInTheDocument()
    expect(within(sites).getByText('SIRET 73282932010008')).toBeInTheDocument()
    expect(within(sites).getByText('18000 m²')).toBeInTheDocument()
    const trigger = screen.getByRole('group', { name: 'Déclencheur' })
    expect(within(trigger).getByText('Ouverture de site')).toBeInTheDocument()
    expect(within(trigger).getByText('Ouverture d’un nouvel entrepôt de 18 000 m².')).toBeInTheDocument()
    expect(within(trigger).getByText('+20')).toBeInTheDocument()
    await user.click(screen.getByText('JSON soumis par l’agent'))
    expect(screen.getByText(/"display_name": "Logistique Y"/)).toBeInTheDocument()
  })
})

describe('Résultat mission', () => {
  it('shows the result card layout for a mission without results yet', async () => {
    stubApi({ ...SHELL_API, ...COMMON, [`GET /api/missions/${MISSION}`]: [200, { ...detail(), tasks: [] }] })

    renderApp(`/missions/${MISSION}/resultat`)

    expect(await screen.findByRole('heading', { level: 1, name: 'Résultat mission' })).toBeInTheDocument()
    expect(await screen.findByText(/Aucun résultat pour l’instant/)).toBeInTheDocument()
    expect(screen.getByRole('link', { name: /Nouveaux entrepôts/ })).toHaveAttribute('href', `/missions/${MISSION}`)
  })
})
