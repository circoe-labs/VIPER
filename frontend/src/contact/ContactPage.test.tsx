import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'

import { contactDashboard, contactRow, message, sent, stubContactApi } from '../test/contactApi'
import { renderApp } from '../test/render'

const LIST = '/api/contact/prospects'

function lastListParams(requests: ReturnType<typeof stubContactApi>['requests']): Record<string, string> {
  const request = sent(requests, 'GET', LIST).at(-1)
  return Object.fromEntries(new URLSearchParams(request?.search ?? ''))
}

const DASHBOARD = contactDashboard({
  today: '2026-10-07',
  cohorts: [
    { code: 'S39', starts_on: '2026-09-28', out_of_campaign: false, prospects: 2, to_send: 2, overdue: 0, to_send_steps: ['r1'] },
    { code: 'S40', starts_on: '2026-10-05', out_of_campaign: false, prospects: 1, to_send: 0, overdue: 0, to_send_steps: [] },
    { code: 'S37', starts_on: '2026-09-07', out_of_campaign: false, prospects: 10, appointments: 1, to_send: 9, overdue: 9, to_send_steps: ['r2'] },
  ],
  categories: [{ category: 'appointment_obtained', count: 2 }],
})

function rows() {
  return [
    contactRow('Jean', 'Exemple', { civility: 'mr', role_label: 'Responsable transport', company_name: 'Alpha SARL', cohort_code: 'S39' }),
    contactRow('Claire', 'Démo', {
      tracking_status: 'neutral',
      next_step: 'r1',
      next_action_week: '2026-W39',
      company_name: 'Bravo SA',
      cohort_code: 'S39',
      messages: { contact: 'sent', r1: 'draft', r2: null },
    }),
    contactRow('Marie', 'Calme', {
      next_step: 'r1',
      due: false,
      next_action_week: '2026-W42',
      company_name: 'Delta SA',
      cohort_code: 'S40',
      messages: { contact: 'sent', r1: null, r2: null },
    }),
    contactRow('Luc', 'Fictif', {
      tracking_status: 'appointment_obtained',
      next_step: null,
      due: false,
      next_action_week: null,
      planned_contact_at: null,
      company_name: 'Charlie SARL',
      cohort_code: 'S40',
      messages: { contact: 'cancelled', r1: null, r2: null },
    }),
  ]
}

describe('Contact page', () => {
  it('replaces Exploitation in the navigation, and the old path leads to it', async () => {
    stubContactApi({ dashboard: DASHBOARD })
    const { router } = renderApp('/exploitation')
    expect(await screen.findByRole('heading', { level: 1, name: 'Contact' })).toBeInTheDocument()
    expect(router.state.location.pathname).toBe('/contact')
    const navigation = screen.getByRole('navigation', { name: 'Navigation principale' })
    expect(within(navigation).getByRole('link', { name: 'Contact' })).toHaveAttribute('aria-current', 'page')
    expect(within(navigation).queryByRole('link', { name: 'Exploitation' })).not.toBeInTheDocument()
  })

  it('warns at the top when scheduled messages will not leave, with the link that fixes it (S9)', async () => {
    stubContactApi({
      dashboard: contactDashboard({
        ...DASHBOARD,
        dispatch: { active: false, reason: 'disabled', scheduled_count: 2, overdue_count: 1 },
      }),
    })
    renderApp('/contact')
    const banner = await screen.findByRole('alert')
    expect(banner).toHaveTextContent(
      '2 messages programmés ne partiront pas : l’envoi automatique des mails programmés est désactivé. 1 a déjà dépassé son heure',
    )
    expect(within(banner).getByRole('link', { name: 'Activer l’envoi automatique' })).toHaveAttribute('href', '/settings/connections')
  })

  it('names the Toolbox when it is the reason, and says nothing while sending is active or nothing waits (S9)', async () => {
    stubContactApi({
      dashboard: contactDashboard({ dispatch: { active: false, reason: 'toolbox_expired', scheduled_count: 1, overdue_count: 0 } }),
    })
    const { unmount } = renderApp('/contact')
    const banner = await screen.findByRole('alert')
    expect(banner).toHaveTextContent('1 message programmé ne partira pas : la connexion à CIRCOE Toolbox a expiré.')
    expect(within(banner).getByRole('link', { name: 'Reconnecter CIRCOE Toolbox' })).toBeInTheDocument()
    unmount()

    stubContactApi({ dashboard: contactDashboard({ dispatch: { active: false, reason: 'disabled', scheduled_count: 0, overdue_count: 0 } }) })
    renderApp('/contact')
    expect(await screen.findByRole('button', { name: /S39/ })).toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('shows one closed section per cohort S37 to S47 (no S38, no S42), then « RDV pris », with its prospect count, and reads nothing until one opens', async () => {
    const api = stubContactApi({ dashboard: DASHBOARD, rows: rows() })
    renderApp('/contact')

    const toggles = await screen.findAllByRole('button', { name: /^(S4?\d|RDV)/ })
    await waitFor(() => {
      expect(toggles[0]).toHaveTextContent('9 prospects')
    })
    // Per cohort: code and count, and what it prepares.
    expect(toggles.map((button) => button.textContent)).toEqual([
      'S379 prospectsR2',
      'S392 prospectsR1',
      'S401 prospectenvoyé',
      'S410 prospectsemaine du 12/10',
      'S430 prospectsemaine du 26/10',
      'S440 prospectsemaine du 02/11',
      'S450 prospectsemaine du 09/11',
      'S460 prospectsemaine du 16/11',
      'S470 prospectsemaine du 23/11',
      'RDV pris2 prospects',
    ])
    for (const toggle of toggles) expect(toggle).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByRole('region', { name: 'Compteurs' })).not.toBeInTheDocument()
    expect(sent(api.requests, 'GET', LIST)).toHaveLength(0)
  })

  it('opens a section with its arrow: its own prospects, every state, alphabetical by company, then closes it', async () => {
    const api = stubContactApi({ dashboard: DASHBOARD, rows: rows() })
    renderApp('/contact')
    const s39 = await screen.findByRole('button', { name: /^S39/ })

    await userEvent.click(s39)
    expect(s39).toHaveAttribute('aria-expanded', 'true')
    const list = await screen.findByRole('list', { name: 'Prospects à contacter' })
    expect(within(list).getAllByRole('listitem')).toHaveLength(2)
    expect(within(list).queryByText('Luc Fictif')).not.toBeInTheDocument()
    expect(lastListParams(api.requests)).toEqual({
      category: 'cohort',
      cohorts: 'S39',
      sort: 'company',
      limit: '200',
      offset: '0',
    })

    await userEvent.click(s39)
    expect(s39).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByRole('list', { name: 'Prospects à contacter' })).not.toBeInTheDocument()
  })

  it('shows each person with state, week, what to prepare and the messages', async () => {
    stubContactApi({ dashboard: DASHBOARD, rows: rows() })
    renderApp('/contact?section=S39')
    const list = await screen.findByRole('list', { name: 'Prospects à contacter' })
    const [jean, claire] = within(list).getAllByRole('listitem') as [HTMLElement, HTMLElement]

    expect(jean).toHaveTextContent('Responsable transport')
    expect(jean).toHaveTextContent('À préparer : Premier contact')
    expect(jean).toHaveTextContent('Aucun message préparé')

    // « En séquence » is the default state: no badge (the level is the next step prepared, not a state).
    expect(claire).not.toHaveTextContent('État :')
    expect(claire).not.toHaveTextContent('Échu')
    expect(claire).not.toHaveTextContent(/S\d\d/)
    expect(claire).toHaveTextContent('À préparer : Relance R1')
    expect(claire).toHaveTextContent(/ContactEnvoyé/)
    expect(claire).toHaveTextContent(/R1Brouillon/)
    expect(claire).toHaveTextContent(/R2Vide/)
  })

  it('keeps the planned week and « Échu » behind a small tab, shown only when opened', async () => {
    stubContactApi({ dashboard: DASHBOARD, rows: rows() })
    renderApp('/contact?section=S39')
    const claire = async () => (await screen.findByText('Claire Démo')).closest('li') as HTMLElement
    expect(await claire()).not.toHaveTextContent('Échu')
    expect(await claire()).not.toHaveTextContent('Semaine prévue')

    const tab = within(await claire()).getByRole('button', { name: 'Détails' })
    expect(tab).toHaveAttribute('aria-expanded', 'false')
    await userEvent.click(tab)
    expect(tab).toHaveAttribute('aria-expanded', 'true')
    expect(await claire()).toHaveTextContent(/Semaine prévue : semaine du .*21 sept/)
    expect(await claire()).toHaveTextContent('Échu')

    await userEvent.click(tab)
    expect(await claire()).not.toHaveTextContent('Échu')
  })

  it('shows nothing to prepare for a person whose mails of the week are already sent', async () => {
    stubContactApi({ dashboard: DASHBOARD, rows: rows() })
    renderApp('/contact?section=S40')
    const list = await screen.findByRole('list', { name: 'Prospects à contacter' })
    const marie = within(list).getByText('Marie Calme').closest('li') as HTMLElement
    expect(marie).not.toHaveTextContent('À préparer')
  })

  it('lists the people who took an appointment apart from their cohort', async () => {
    const api = stubContactApi({ dashboard: DASHBOARD, rows: rows() })
    renderApp('/contact')
    await userEvent.click(await screen.findByRole('button', { name: /^RDV pris/ }))
    const list = await screen.findByRole('list', { name: 'Prospects à contacter' })
    expect(within(list).getAllByRole('listitem')).toHaveLength(1)
    expect(within(list).getByText('Luc Fictif')).toBeInTheDocument()
    expect(lastListParams(api.requests)).toMatchObject({ category: 'appointment_obtained', sort: 'company' })
    expect(lastListParams(api.requests)).not.toHaveProperty('cohorts')
  })

  it('says when a cohort holds nobody yet', async () => {
    stubContactApi({ dashboard: DASHBOARD, rows: rows() })
    renderApp('/contact')
    await userEvent.click(await screen.findByRole('button', { name: /^S44/ }))
    expect(await screen.findByText('Aucun prospect dans cette cohorte pour le moment.')).toBeInTheDocument()
  })

  it('narrows every opened section with the search box, kept in the URL', async () => {
    const api = stubContactApi({ dashboard: DASHBOARD, rows: rows() })
    const { router } = renderApp('/contact?section=S39')
    await screen.findByRole('list', { name: 'Prospects à contacter' })

    await userEvent.type(screen.getByRole('searchbox'), 'alpha')
    await waitFor(() => {
      expect(router.state.location.search).toBe('?section=S39&q=alpha')
    })
    await waitFor(() => {
      const lists = sent(api.requests, 'GET', LIST).map((r) => Object.fromEntries(new URLSearchParams(r.search)))
      expect(lists).toContainEqual(expect.objectContaining({ q: 'alpha', cohorts: 'S39' }))
    })
  })

  it('opens the sections that hold a match when searching, closed ones included', async () => {
    const api = stubContactApi({ dashboard: DASHBOARD, rows: rows() })
    renderApp('/contact')
    await screen.findByText('S39')

    await userEvent.type(screen.getByRole('searchbox'), 'alpha')
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /S39/ })).toHaveAttribute('aria-expanded', 'true')
    })
    expect(sent(api.requests, 'GET', LIST).length).toBeGreaterThan(0)
  })

  it('shows a counters failure with « Réessayer »', async () => {
    stubContactApi({ dashboard: 'error' })
    renderApp('/contact')
    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('Compteurs indisponibles')
    expect(within(alert).getByRole('button', { name: 'Réessayer' })).toBeInTheDocument()
  })

  it('opens the workbench in place of the sections; Back returns to the section, open', async () => {
    const people = rows()
    const [jean, claire] = people as [ReturnType<typeof contactRow>, ReturnType<typeof contactRow>]
    const { prospectDetail } = await import('../test/prospectsApi')
    stubContactApi({
      dashboard: DASHBOARD,
      rows: people,
      details: [prospectDetail({ id: jean.id, first_name: 'Jean', last_name: 'Exemple', civility: 'mr' })],
      messages: { [jean.id]: { contact: message('contact', 'draft') } },
    })
    const { router } = renderApp('/contact')
    await userEvent.click(await screen.findByRole('button', { name: /^S39/ }))
    const list = await screen.findByRole('list', { name: 'Prospects à contacter' })
    await userEvent.click(within(list).getByRole('link', { name: 'Jean Exemple' }))

    expect(await screen.findByRole('heading', { level: 2, name: /Jean Exemple/ })).toBeInTheDocument()
    expect(screen.queryByRole('list', { name: 'Prospects à contacter' })).not.toBeInTheDocument()
    // « Précédent » / « Suivant » walk the cohort of the section, not the whole base.
    expect(await screen.findByText('1 sur 2')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Précédent' })).toBeDisabled()
    expect(router.state.location.search).toBe(`?section=S39&prospect=${jean.id}`)

    await userEvent.click(screen.getByRole('button', { name: 'Suivant' }))
    await waitFor(() => {
      expect(router.state.location.search).toContain(`prospect=${claire.id}`)
    })
    // The walk replaces the entry: Back never reopens a prospect that was left.
    expect(router.state.historyAction).toBe('REPLACE')

    await userEvent.click(screen.getByRole('button', { name: 'Retour à la liste' }))
    expect(await screen.findByRole('list', { name: 'Prospects à contacter' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /^S39/ })).toHaveAttribute('aria-expanded', 'true')
    // The section stays open in the page; the entry it returns to is the list's own.
    expect(router.state.location.search).toBe('')
    // « Retour à la liste » goes back to the list's own entry (no new entry that Back would undo).
    expect(router.state.historyAction).toBe('POP')
  })
})
