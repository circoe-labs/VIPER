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
  companies: 7,
  stages: { quote_sent: 2, quote_follow_up: 1, won: 1, not_interested: 4 },
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
          tracking_status: 'to_contact',
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
      occurred_at: '2026-09-10T12:15:00+00:00',
      actor: { kind: 'human', label: 'Pilote Test', id: 'user-1', on_behalf_of: null },
      source: 'ui',
      subject_type: 'prospect',
      subject_id: PERSON,
      subject_label: 'Jean Echu',
      summary: ['E-mail principal modifié', 'E-mail ajouté', 'Suivi : À contacter → Contacté'],
    },
    {
      occurred_at: '2026-09-10T11:00:00+00:00',
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
  it('leads with the state of the base and the contact activity, each card opening its Prospection segment', async () => {
    renderHome()

    expect(await screen.findByRole('heading', { level: 2, name: 'État de la base' })).toBeInTheDocument()
    const headings = screen.getAllByRole('heading', { level: 2 }).map((heading) => heading.textContent)
    expect(headings).toEqual([
      'État de la base',
      'Activité de contact',
      'Prochaines actions',
      'Progression du mois',
      'Derniers imports',
      'Dernières modifications',
    ])

    expect(card('Base', 'Prospects')).toHaveAttribute('href', '/prospection')
    expect(card('Base', 'Prospects')).toHaveTextContent(String(COUNTS.all))
    expect(card('Base', 'Entreprises')).toHaveAttribute('href', '/prospection/companies')
    expect(card('Base', 'Entreprises')).toHaveTextContent('7')
    expect(card('Base', 'Opposition')).toHaveAttribute('href', '/prospection?segment=do_not_contact')
    expect(card('Vérification', 'Jamais vérifiés')).toHaveAttribute('href', '/prospection?segment=never_verified')
    expect(card('Suivi de contact', 'Échus')).toHaveAttribute('href', '/prospection?segment=due')
    expect(card('Suivi de contact', 'Échus')).toHaveTextContent(String(COUNTS.due))
    expect(card('Suivi de contact', 'Sans réponse')).toHaveAttribute('href', '/prospection?segment=no_response')
    expect(card('Suivi de contact', 'Rendez-vous')).toHaveAttribute('href', '/prospection?segment=appointments')
    // Every segment but « Tous » (the Prospects card) has exactly one card.
    const segmentLinks = ['Base', 'Vérification', 'Suivi de contact']
      .flatMap((name) => within(group(name)).getAllByRole('link'))
      .map((link) => link.getAttribute('href') ?? '')
      .filter((href) => href.includes('segment='))
    expect(segmentLinks.sort()).toEqual(SEGMENTS.filter((s) => s !== 'all').map((s) => `/prospection?segment=${s}`).sort())

    expect(card('Suivi commercial léger', 'Devis envoyé')).toHaveAttribute('href', '/prospection?tracking_status=quote_sent')
    expect(card('Suivi commercial léger', 'Gagné')).toHaveTextContent('1')
    expect(card('Suivi commercial léger', 'Pas intéressé')).toHaveTextContent('4')
    expect(card('Suivi de contact', 'Échus')).toHaveAttribute('title', 'À contacter, contact prévu au plus tard aujourd’hui.')
  })

  it('opens Prospection on the segment of a clicked card', async () => {
    const { router } = renderHome()

    await userEvent.click(await screen.findByRole('link', { name: /^Sans réponse/ }))

    expect(router.state.location.pathname).toBe('/prospection')
    expect(router.state.location.search).toBe('?segment=no_response')
  })

  it('shows the month against informative targets, with a text alternative for every figure', async () => {
    renderHome()

    const progress = await screen.findByRole('region', { name: 'Progression du mois' })
    expect(within(progress).getByText('septembre 2026', { selector: '.home-panel__meta' })).toBeInTheDocument()
    const contacted = within(progress).getByRole('meter', { name: 'Prospects contactés pour la première fois' })
    expect(contacted).toHaveAttribute('aria-valuetext', '37 sur un objectif indicatif de 100 (37 %)')
    expect(contacted).toHaveAttribute('aria-valuenow', '37')
    // Above the target: the meter is full, the text says by how much.
    const appointments = within(progress).getByRole('meter', { name: 'Rendez-vous obtenus' })
    expect(appointments).toHaveAttribute('aria-valuenow', '10')
    expect(appointments).toHaveAttribute('aria-valuetext', '12 sur un objectif indicatif de 10 (120 %)')
    expect(within(progress).getByText('Objectif indicatif : 100 · 37 %')).toBeInTheDocument()

    await userEvent.click(within(progress).getByText('Détail des 6 derniers mois'))
    const rows = within(within(progress).getByRole('table')).getAllByRole('row')
    expect(rows.map((row) => row.textContent)).toEqual([
      'MoisContactésRendez-vous',
      'avril 2026121',
      'mai 2026302',
      'juin 2026445',
      'juillet 202680',
      'août 2026616',
      'septembre 20263712',
    ])
  })

  it('lists next actions that open the person in their Prospection queue', async () => {
    renderHome()

    const actions = await screen.findByRole('region', { name: 'Prochaines actions' })
    const due = within(actions).getByRole('list', { name: /Contacts échus/ })
    const jean = within(due).getByRole('link', { name: 'Jean Echu' })
    expect(jean).toHaveAttribute('href', `/prospection?segment=due&sort=planned_contact&prospect=${PERSON}`)
    expect(within(due).getByRole('listitem')).toHaveTextContent('Transports Exemple SARL')
    expect(within(due).getByRole('listitem')).toHaveTextContent(/Prévu le 8 sept\.$/)
    expect(within(actions).getByRole('link', { name: 'Tous les échus' })).toHaveAttribute(
      'href',
      '/prospection?segment=due&sort=planned_contact',
    )
    const appointment = within(actions).getByRole('list', { name: /Rendez-vous des 7 prochains jours/ })
    expect(within(appointment).getByRole('listitem')).toHaveTextContent(
      'Rendez-vous le 14 sept. à 10:30 · Rendez-vous obtenu · Référent : Camille Référente',
    )
    expect(within(actions).getByText('Aucune réponse en attente d’un rendez-vous.')).toBeInTheDocument()
    expect(within(actions).queryByRole('link', { name: 'Toutes les réponses' })).not.toBeInTheDocument()
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

    const edits = screen.getByRole('region', { name: 'Dernières modifications' })
    const [saved, deleted] = within(edits).getAllByRole('listitem') as [HTMLElement, HTMLElement]
    expect(within(saved).getByRole('link', { name: 'Jean Echu' })).toHaveAttribute('href', `/prospection?prospect=${PERSON}`)
    expect(saved).toHaveTextContent('E-mail principal modifié · E-mail ajouté · Suivi : À contacter → Contacté')
    expect(saved).toHaveTextContent('Pilote Test · 10 sept. à 14:15')
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
    expect(screen.queryByRole('heading', { name: 'État de la base' })).not.toBeInTheDocument()
    expect(screen.queryByRole('meter')).not.toBeInTheDocument()
    expect(screen.getByText('Aucun import pour l’instant.')).toBeInTheDocument()
    expect(screen.getByText('Aucune modification manuelle pour l’instant.')).toBeInTheDocument()
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

    await screen.findByRole('heading', { level: 2, name: 'État de la base' })
    const scope = screen.getByText(/ne font pas partie de la V1/)
    expect(scope).toHaveTextContent('Les envois d’e-mails, Calendly et les agents de prospection ne font pas partie de la V1.')
    expect(screen.getAllByRole('meter')).toHaveLength(2)
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
