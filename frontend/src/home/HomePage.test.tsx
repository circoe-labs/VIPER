import { screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'

import type { HomeData } from '../api/home'
import type { ImportBatch } from '../api/imports'
import { SEGMENTS } from '../api/prospection'
import { ProspectEditorContext } from '../prospection/prospectEditor'
import { homeData, SHELL_API } from '../test/homeApi'
import { renderApp, stubApi } from '../test/render'

const PERSON = '00000000-0000-7000-c000-000000000001'
const OTHER = '00000000-0000-7000-c000-000000000002'
const BATCH = '00000000-0000-7000-d000-000000000001'

const COUNTS = Object.fromEntries(SEGMENTS.map((segment, index) => [segment, (index + 1) * 3])) as HomeData['counts']

function batch(fields: Partial<ImportBatch>): ImportBatch {
  return {
    id: BATCH,
    filename: 'base_synthetique.xlsx',
    sheet_names: ['Feuil1'],
    status: 'committed',
    created_at: '2026-09-09T08:00:00+00:00',
    committed_at: '2026-09-09T08:01:00+00:00',
    actor_type: 'human',
    actor_display: 'Pilote Test',
    rows_total: 14,
    rows_imported: 12,
    rows_skipped: 2,
    legal_basis_or_collection_context: 'Intérêt légitime (test)',
    source_reference: null,
    ...fields,
  }
}

const FILLED = homeData({
  counts: COUNTS,
  figures: {
    disqualified: 4,
    mail_inactive: 5,
    incomplete: 6,
    responses_this_week: 7,
    responses_last_week: 3,
    responses_this_month: 20,
  },
  companies: 7,
  contact_week: { week: '2026-W37', monday: '2026-09-07', to_send: 5, overdue: 2 },
  progress: {
    contact_target: 100,
    appointment_target: 10,
    months: [
      ['04', 12, 1],
      ['05', 30, 2],
      ['06', 44, 5],
      ['07', 8, 0],
      ['08', 61, 6],
      ['09', 37, 12],
    ].map(([month, contacted, appointments]) => ({
      month: `2026-${String(month)}-01`,
      contacted: Number(contacted),
      appointments: Number(appointments),
    })),
  },
  next_actions: {
    appointments: {
      total: 1,
      items: [
        {
          prospect_id: OTHER,
          first_name: 'Emma',
          last_name: 'Rendezvous',
          company_name: 'Logistique Témoin SAS',
          tracking_status: 'appointment_obtained',
          at: '2026-09-14T08:30:00+00:00',
          referent_name: 'Camille Référente',
        },
      ],
    },
    due: {
      total: 9,
      items: [
        {
          prospect_id: PERSON,
          first_name: 'Jean',
          last_name: 'Echu',
          company_name: 'Transports Exemple SARL',
          tracking_status: 'neutral',
          at: '2026-09-07T22:00:00+00:00',
          referent_name: null,
        },
      ],
    },
    responses: { total: 0, items: [] },
  },
  recent_imports: [batch({}), batch({ id: 'failed', filename: 'refus.xlsx', status: 'failed', committed_at: null })],
  recent_edits: [
    {
      occurred_at: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
      actor: { kind: 'human', label: 'Pilote Test', id: 'user-1', on_behalf_of: null },
      source: 'ui',
      subject_type: 'prospect',
      subject_id: PERSON,
      subject_label: 'Jean Echu',
      summary: ['E-mail principal modifié', 'E-mail ajouté', 'Suivi : Aucun état → Contacté'],
    },
    {
      occurred_at: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
      actor: { kind: 'human', label: 'Pilote Test', id: 'user-1', on_behalf_of: null },
      source: 'database_explorer',
      subject_type: 'prospect',
      subject_id: OTHER,
      subject_label: null,
      summary: ['Fiche supprimée'],
    },
  ],
})

function renderHome(data: HomeData = FILLED, options: Parameters<typeof renderApp>[1] = {}) {
  stubApi({ ...SHELL_API, 'GET /api/home': [200, data] })
  return renderApp('/', options)
}

function group(name: string) {
  return screen.getByRole('list', { name })
}

function card(listName: string, label: string) {
  return within(group(listName)).getByRole('link', { name: new RegExp(`^${label}`) })
}

describe('Home page', () => {
  it('leads with the base and the contact activity in few cards, each opening its Prospection segment when one exists', async () => {
    renderHome()

    expect(await screen.findByRole('heading', { level: 2, name: 'Base' })).toBeInTheDocument()
    const headings = screen.getAllByRole('heading', { level: 2 }).map((heading) => heading.textContent)
    expect(headings).toEqual([
      'Base',
      'Activité de contact',
      'Semaine à contacter',
      'Progression du mois',
      'Derniers imports',
    ])

    // Base: Prospects, RDV confirmé, Défaillant, À vérifier and the answers' trend.
    expect(within(group('Base')).getAllByRole('listitem')).toHaveLength(5)
    expect(card('Base', 'Prospects')).toHaveAttribute('href', '/prospection')
    expect(card('Base', 'Prospects')).toHaveTextContent(String(COUNTS.all))
    expect(card('Base', 'RDV confirmé')).toHaveAttribute('href', '/prospection?segment=appointments')
    expect(within(group('Base')).getByTitle(/Sans réponse après la dernière relance/)).toHaveTextContent('4')
    expect(within(group('Base')).getByTitle(/Informations incomplètes/)).toHaveTextContent('6')
    // Activité de contact: four cards.
    expect(within(group('Activité de contact')).getAllByRole('listitem')).toHaveLength(4)
    expect(card('Activité de contact', 'À contacter')).toHaveAttribute('href', '/prospection?segment=due')
    expect(card('Activité de contact', 'Sans réponse')).toHaveAttribute('href', '/prospection?segment=no_response')
    expect(card('Activité de contact', 'RDV')).toHaveAttribute('href', '/prospection?segment=appointments')
    expect(within(group('Activité de contact')).getByTitle(/les e-mails envoyés reviennent/)).toHaveTextContent('5')
  })

  it('shows a rising green arrow when answers hold up and a falling red one when they drop', async () => {
    renderHome()
    expect(await screen.findByText(/En hausse ou stable/)).toHaveTextContent('7 cette semaine, 3 la semaine passée')
  })

  it('shows a falling arrow when answers drop against last week', async () => {
    renderHome({ ...FILLED, figures: { ...FILLED.figures, responses_this_week: 1, responses_last_week: 4 } })
    expect(await screen.findByText(/En baisse/)).toHaveTextContent('1 cette semaine, 4 la semaine passée')
  })

  it('names the cohort to contact each weekday', async () => {
    renderHome()
    const week = await screen.findByRole('region', { name: 'Semaine à contacter' })
    const items = within(week).getAllByRole('listitem')
    expect(items.map((item) => item.textContent)).toEqual([
      expect.stringMatching(/^Semaine 37 à contacter le lundi 7 septembre/),
      expect.stringMatching(/^Semaine 39 à contacter le mardi 8 septembre/),
      expect.stringMatching(/^Semaine 40 à contacter le mercredi 9 septembre/),
      expect.stringMatching(/^Semaine 41 à contacter le jeudi 10 septembre · aujourd’hui/),
    ])
  })

  it('opens Prospection on the segment of a clicked card', async () => {
    const { router } = renderHome()

    await userEvent.click(await screen.findByRole('link', { name: /^Sans réponse/ }))

    expect(router.state.location.pathname).toBe('/prospection')
    expect(router.state.location.search).toBe('?segment=no_response')
  })

  it('shows the month’s results as a pie with a colour-coded legend', async () => {
    renderHome()

    const progress = await screen.findByRole('region', { name: 'Progression du mois' })
    expect(within(progress).getByText('septembre 2026', { selector: '.home-panel__meta' })).toBeInTheDocument()
    expect(within(progress).getByRole('img', { name: 'Résultats du mois' })).toBeInTheDocument()
    const legend = within(progress).getAllByRole('listitem').map((item) => item.textContent)
    // 37 contacted, 12 appointments, 20 answers this month: 12 RDV, 8 answers without RDV, 17 without answer.
    expect(legend).toEqual(['RDV pris 12', 'Réponse sans RDV 8', 'Sans réponse 17'])
  })

  it('shows the latest imports and manual saves as readable lines, never raw data', async () => {
    renderHome()

    const imports = await screen.findByRole('region', { name: 'Derniers imports' })
    const [committed, failed] = within(imports).getAllByRole('listitem') as [HTMLElement, HTMLElement]
    expect(within(committed).getByRole('link', { name: 'base_synthetique.xlsx' })).toHaveAttribute(
      'href',
      `/prospection?import_batch=${BATCH}`,
    )
    expect(committed).toHaveTextContent('Importé')
    expect(committed).toHaveTextContent('12 lignes importées sur 14 · 2 exclues')
    expect(committed).toHaveTextContent('Pilote Test · 9 sept. à 10:01')
    expect(within(failed).queryByRole('link')).not.toBeInTheDocument()
    expect(failed).toHaveTextContent('Échec, rien importé')

    const edits = screen.getByRole('region', { name: /^Dernières modifications/ })
    await userEvent.click(within(edits).getByText('Dernières modifications'))
    const [saved, deleted] = within(edits).getAllByRole('listitem') as [HTMLElement, HTMLElement]
    expect(within(saved).getByRole('link', { name: 'Jean Echu' })).toHaveAttribute('href', `/prospection?prospect=${PERSON}`)
    expect(saved).toHaveTextContent('E-mail principal modifié · E-mail ajouté · Suivi : Aucun état → Contacté')
    expect(saved).toHaveTextContent(/Pilote Test · \d+ \S+ à \d\d:\d\d/)
    expect(deleted).toHaveTextContent('Prospect supprimé')
    expect(deleted).toHaveTextContent('Fiche supprimée')
    expect(deleted).toHaveTextContent('Pilote Test · via Base de données')
    expect(within(deleted).queryByRole('link')).not.toBeInTheDocument()
    expect(edits.textContent).not.toMatch(/[{}]|prospect\.|contact_tracking/)
  })

  it('invites to import when the base is empty, without figures', async () => {
    renderHome(homeData())

    expect(await screen.findByRole('heading', { level: 2, name: 'La base est vide' })).toBeInTheDocument()
    const main = screen.getByRole('main')
    expect(within(main).getAllByRole('link', { name: 'Importer Excel' })).toHaveLength(2)
    // The Prospect editor (Task 15) can create a person: the empty base also offers to add one by hand.
    expect(within(main).getByRole('link', { name: 'Ajouter un prospect' })).toHaveAttribute('href', '/prospection?prospect=new')
    expect(screen.queryByRole('heading', { name: 'Base' })).not.toBeInTheDocument()
    expect(screen.getByText('Aucun import pour l’instant.')).toBeInTheDocument()
  })

  it('does not offer to add a prospect when the prospect editor cannot create one', async () => {
    renderHome(homeData(), {
      wrap: (app) => <ProspectEditorContext.Provider value={{ canCreate: false, Editor: () => null }}>{app}</ProspectEditorContext.Provider>,
    })

    expect(await screen.findByRole('heading', { level: 2, name: 'La base est vide' })).toBeInTheDocument()
    expect(within(screen.getByRole('main')).queryByRole('link', { name: 'Ajouter un prospect' })).not.toBeInTheDocument()
  })

  it('says honestly what V1 does not show, and mocks no agent, e-mail or Calendly figure', async () => {
    renderHome()

    await screen.findByRole('heading', { level: 2, name: 'Base' })
    const scope = screen.getByText(/ne font pas partie de la V1/)
    expect(scope).toHaveTextContent(
      'L’envoi automatique des e-mails, Calendly et les agents de prospection ne font pas partie de la V1.',
    )
    const main = screen.getByRole('main')
    for (const widget of [/e-mails envoyés/i, /taux d.ouverture/i, /IProspect|IContact/, /agent actif/i]) {
      expect(within(main).queryByText(widget)).not.toBeInTheDocument()
    }
  })

  it('reports an unavailable Home and retries', async () => {
    stubApi({ ...SHELL_API, 'GET /api/home': [500, { detail: 'boom' }] })
    renderApp('/')

    expect(await screen.findByRole('alert')).toHaveTextContent('Accueil indisponible.')
    stubApi(SHELL_API)
    await userEvent.click(screen.getByRole('button', { name: 'Réessayer' }))
    expect(await screen.findByRole('heading', { level: 2, name: 'La base est vide' })).toBeInTheDocument()
  })
})
