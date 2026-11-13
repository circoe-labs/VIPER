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
    const link = screen.getByRole('link', { name: /Nouveaux entrepôts/ })
    expect(link).toHaveAttribute('href', `/missions/${MISSION}`)
    expect(within(link).getByText('Enrichissement')).toBeInTheDocument()
    expect(within(link).getByText('Agent claude-01')).toBeInTheDocument()
    expect(within(link).getByText('Toutes les 24 heures')).toBeInTheDocument()
    expect(within(link).getByText('1 à relire')).toBeInTheDocument()
    expect(within(link).getByText('1 à valider')).toBeInTheDocument()
    expect(within(link).getByText('1 tâche')).toBeInTheDocument()
    // 0 of 1 task accepted: a real 0 %, with a labelled bar.
    expect(within(link).getByRole('progressbar', { name: 'Progression : 0 % des tâches validées' })).toBeInTheDocument()
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
    return { user, dialog: await screen.findByRole('dialog', { name: 'Nouvelle mission' }) }
  }

  it('suggests a name from the consigne and says what is missing before saving', async () => {
    const { user, dialog } = await openCreate()

    await user.type(within(dialog).getByLabelText(/Consigne/), 'Trouve les commissaires au transport en Normandie')

    expect(within(dialog).getByLabelText(/Nom/)).toHaveValue('Trouve les commissaires au transport en Normandie')
    // « Compléter des fiches » by default: it works on linked records, none yet.
    expect(within(dialog).getByRole('radio', { name: 'Compléter des fiches' })).toHaveAttribute('aria-checked', 'true')
    expect(within(dialog).getByRole('status')).toHaveTextContent('Liez au moins une fiche')
    expect(within(dialog).getByRole('button', { name: 'Créer la mission' })).toBeDisabled()
    expect(within(dialog).getByRole('button', { name: 'Créer la mission' })).toBeDisabled()

    // A discovery starts from nothing: ready at once.
    await user.click(within(dialog).getByRole('radio', { name: 'Découvrir des sociétés' }))
    expect(within(dialog).getByRole('status')).toHaveTextContent('Prête à être lancée')
    expect(within(dialog).getByRole('button', { name: 'Créer la mission' })).toBeEnabled()
    expect(within(dialog).getByRole('button', { name: 'Créer la mission' })).toBeEnabled()
  })

  it('blocks a signals mission without a company to watch, and explains each kind on hover', async () => {
    const { user, dialog } = await openCreate()
    await user.type(within(dialog).getByLabelText(/Consigne/), 'Nouveaux entrepôts en Normandie')

    await user.click(within(dialog).getByRole('radio', { name: 'Surveiller des signaux' }))

    expect(within(dialog).getByRole('status')).toHaveTextContent('Liez au moins une société à surveiller')
    expect(within(dialog).getByRole('button', { name: 'Créer la mission' })).toBeDisabled()
    expect(within(dialog).getByRole('button', { name: 'Créer la mission' })).toBeDisabled()
    // The explanation is a hover/focus tip, linked to its « i » for assistive tech.
    const tip = within(dialog).getByRole('button', { name: 'Aide : Surveiller des signaux' })
    expect(tip).toHaveAccessibleDescription(/surveille les sociétés liées/)
    await user.hover(tip)
    expect(document.querySelector('.info-tip__bubble')).toHaveTextContent(/surveille les sociétés liées/)
    await user.unhover(tip)
    expect(document.querySelector('.info-tip__bubble')).toBeNull()
  })

  it('moves between kinds with the arrow keys', async () => {
    const { user, dialog } = await openCreate()
    within(dialog).getByRole('radio', { name: 'Compléter des fiches' }).focus()

    await user.keyboard('{ArrowRight}')

    expect(within(dialog).getByRole('radio', { name: 'Vérifier des fiches' })).toHaveAttribute('aria-checked', 'true')
    expect(within(dialog).getByRole('radio', { name: 'Vérifier des fiches' })).toHaveFocus()
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
    const name = within(dialog).getByRole('textbox', { name: 'Nom' })
    expect(name).toHaveValue('Nouveaux entrepôts — Normandie')
    expect(within(dialog).getByRole('textbox', { name: 'Consigne' })).toHaveValue(
      'Complète ces fiches avec le site web et le domaine e-mail.',
    )
    expect(within(dialog).getByText('Transports X')).toBeInTheDocument()
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
    expect(screen.getByText('2SN')).toBeInTheDocument()
    expect(screen.getByText('2SN recrute son premier responsable commercial.')).toBeInTheDocument()
    expect(screen.getByText('2026-10-25')).toBeInTheDocument()
    expect(screen.getByText('+15')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'source' })).toHaveAttribute(
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
