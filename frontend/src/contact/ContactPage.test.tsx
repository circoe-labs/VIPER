import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'

import type { ContactDashboard } from '../api/contact'
import { contactDashboard, contactOverview, contactRow, message, sent, stubContactApi } from '../test/contactApi'
import { renderApp } from '../test/render'

const LIST = '/api/contact/prospects'

const CONTACTED = '/contact?view=contacted'

async function openList(name = 'Prospects contactés') {
  return screen.findByRole('list', { name })
}

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
  categories: [{ category: 'contacted', count: 4 }],
})

// The planning the backend sends: `to_send` is not in the shared type yet (Slice 01), hence the cast.
const PLANNING = {
  ...contactDashboard({
    ...DASHBOARD,
    categories: [
      { category: 'contacted', count: 4 },
      { category: 'response_received', count: 2 },
      { category: 'appointment_obtained', count: 1 },
      { category: 'email_error', count: 6 },
    ],
    weeks: [
      { week: '2026-W39', year: 2026, number: 39, count: 2 },
      { week: '2026-W40', year: 2026, number: 40, count: 3 },
      { week: '2026-W42', year: 2026, number: 42, count: 5 },
    ],
  }),
  to_send: { total: 8, overdue: 4, groups: [{ rank: 0, count: 3, overdue: 1 }, { rank: 1, count: 5, overdue: 3 }] },
} as ContactDashboard

function rows() {
  return [
    contactRow('Jean', 'Exemple', { civility: 'mr', role_label: 'Responsable transport', company_name: 'Alpha SARL', cohort_code: 'S39', messages: { contact: 'sent' } }),
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
      messages: { contact: 'sent', r1: null, r2: null },
    }),
  ]
}

describe('Contact page', () => {
  it('shows the actual last email date independently of a later response', async () => {
    const row = contactRow('Jean', 'Exemple', { messages: { contact: 'sent' }, last_email_sent_at: '2026-09-14T10:00:00Z', last_contact_at: '2026-10-01T10:00:00Z' })
    stubContactApi({ rows: [row] })
    renderApp(CONTACTED)
    const list = await openList()
    expect(within(list).getByText('Dernier e-mail envoyé')).toBeInTheDocument()
    expect(within(list).getByText('14 septembre 2026')).toBeInTheDocument()
    expect(within(list).queryByText('1 octobre 2026')).not.toBeInTheDocument()
  })
  it('has no Exploitation item in the navigation, and the old path leads to Contact', async () => {
    stubContactApi({ dashboard: DASHBOARD })
    const { router } = renderApp('/exploitation')
    expect(await screen.findByRole('heading', { level: 1, name: 'Contacts' })).toBeInTheDocument()
    expect(router.state.location.pathname).toBe('/contact')
    const navigation = screen.getByRole('navigation', { name: 'Navigation principale' })
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
    expect(await screen.findByRole('heading', { level: 2, name: /^Prospects à contacter/ })).toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('starts on the people to contact, behind capsules that each open one list', async () => {
    const api = stubContactApi({ dashboard: PLANNING, rows: rows() })
    renderApp('/contact')

    expect(await screen.findByRole('heading', { level: 2, name: /^Prospects à contacter/ })).toBeInTheDocument()
    await openList('Prospects à contacter')
    expect(lastListParams(api.requests)).toEqual({ category: 'to_send', sort: 'due', limit: '200', offset: '0', rank: '0' })
    expect(sent(api.requests, 'GET', '/api/contact/scheduling')).toHaveLength(0)

    const capsules = within(screen.getByRole('navigation', { name: 'Suivi commercial' }))
    const expected: [string, string, string][] = [
      ['À contacter', '3', 'to_contact'],
      ['Relances à faire', '5', 'follow_ups'],
      ['En retard', '4', 'overdue'],
      ['Contactés', '4', 'contacted'],
      ['Réponses', '2', 'responses'],
      ['RDV pris', '1', 'appointments'],
      ['Erreurs mail', '6', 'mail_errors'],
    ]
    for (const [label, count, view] of expected) {
      const link = capsules.getByRole('link', { name: new RegExp(`^${label}\\s*${count}`) })
      expect(link).toHaveAttribute('href', `/contact?view=${view}`)
    }
    expect(capsules.getByRole('link', { name: /^À contacter/ })).toHaveAttribute('aria-current', 'page')
    expect(capsules.getByRole('link', { name: /^À contacter/ })).toHaveTextContent('dont 1 en retard')
  })

  it('never invents a figure the planning does not carry', async () => {
    stubContactApi({ dashboard: contactDashboard({ ...DASHBOARD, categories: undefined }), rows: rows() })
    renderApp('/contact')
    const capsules = within(await screen.findByRole('navigation', { name: 'Suivi commercial' }))
    expect(capsules.getByRole('link', { name: /^À contacter/ })).toHaveTextContent('—')
    expect(capsules.getByRole('link', { name: /^Réponses/ })).toHaveTextContent('—')
    expect(capsules.queryByText(/devis|opportunit|inactif/i)).not.toBeInTheDocument()
  })

  it('opens the contacted list from its capsule, with the repartition chart', async () => {
    const api = stubContactApi({ dashboard: PLANNING, rows: rows() })
    const { router } = renderApp('/contact')
    await userEvent.click(await screen.findByRole('link', { name: /^Contactés/ }))
    const list = await openList()
    expect(router.state.location.search).toBe('?view=contacted')
    expect(within(list).getAllByRole('listitem')).toHaveLength(4)
    expect(screen.getByRole('heading', { level: 2, name: /^Prospects contactés/ })).toHaveTextContent('4 prospects')
    expect(lastListParams(api.requests)).toEqual({ category: 'contacted', sort: 'company', limit: '200', offset: '0' })
    expect(screen.getByRole('region', { name: 'Graphique des contacts' })).toBeVisible()
  })

  it('lists the replies, the appointments and the mail errors from their own category', async () => {
    const api = stubContactApi({ dashboard: PLANNING, rows: rows() })
    const { router } = renderApp('/contact?view=appointments')
    const list = await openList('Rendez-vous obtenus')
    expect(within(list).getAllByRole('listitem')).toHaveLength(1)
    expect(within(list).getByText('Luc Fictif')).toBeInTheDocument()
    expect(lastListParams(api.requests)).toMatchObject({ category: 'appointment_obtained' })
    await userEvent.click(screen.getByRole('link', { name: /^Réponses/ }))
    await waitFor(() => { expect(lastListParams(api.requests)).toMatchObject({ category: 'response_received' }) })
    await userEvent.click(screen.getByRole('link', { name: /^Erreurs mail/ }))
    await waitFor(() => { expect(lastListParams(api.requests)).toMatchObject({ category: 'email_error' }) })
    expect(router.state.location.search).toBe('?view=mail_errors')
  })

  it('lists the people to contact week by week, the week living in the URL', async () => {
    const api = stubContactApi({ dashboard: PLANNING, rows: rows() })
    const { router } = renderApp('/contact?view=to_contact')
    await userEvent.click(await screen.findByText('Filtres', { selector: 'summary' }))
    const select = await screen.findByRole('combobox', { name: 'Semaine d’envoi' })
    // Past weeks are overdue, not « upcoming »: only this week and the next ones are offered.
    expect(within(select).getAllByRole('option').map((option) => option.getAttribute('value'))).toEqual(['', '2026-W40', '2026-W42'])
    await userEvent.selectOptions(select, '2026-W42')
    await waitFor(() => { expect(router.state.location.search).toBe('?view=to_contact&week=2026-W42') })
    await waitFor(() => { expect(lastListParams(api.requests)).toMatchObject({ category: 'to_send', rank: '0', week: '2026-W42' }) })
  })

  it('narrows « to send » to the late sends and to the follow-ups, never beyond what the rows say', async () => {
    const late = contactRow('Lena', 'Retard', { next_step: 'contact', planned_contact_at: '2026-09-20T08:00:00Z', messages: {} })
    const week = contactRow('Wim', 'Semaine', { next_step: 'r1', planned_contact_at: '2026-09-30T08:00:00Z', messages: { contact: 'sent' } })
    const first = contactRow('Fay', 'Premier', { next_step: 'contact', planned_contact_at: '2026-09-30T08:00:00Z', messages: {} })
    stubContactApi({ dashboard: PLANNING, rows: [late, week, first] })
    const { unmount } = renderApp('/contact?view=overdue')
    const overdue = await openList('Envois en retard')
    expect(within(overdue).getAllByRole('listitem')).toHaveLength(1)
    expect(within(overdue).getByText('Lena Retard')).toBeInTheDocument()
    expect(within(overdue).getByText('Contact prévu')).toBeInTheDocument()
    unmount()

    stubContactApi({ dashboard: PLANNING, rows: [late, week, first] })
    renderApp('/contact?view=follow_ups')
    const followUps = await openList('Relances à faire cette semaine')
    expect(within(followUps).getAllByRole('listitem')).toHaveLength(1)
    expect(within(followUps).getByText('Wim Semaine')).toBeInTheDocument()
  })

  it('explains when no prospect has been contacted yet', async () => {
    stubContactApi({ rows: [contactRow('Jean', 'Nouveau')] })
    renderApp(CONTACTED)
    expect(await screen.findByText('Aucun prospect contacté pour le moment.')).toBeInTheDocument()
  })

  it('searches contacted prospects and keeps the search in the URL', async () => {
    const api = stubContactApi({ dashboard: DASHBOARD, rows: rows() })
    const { router } = renderApp(CONTACTED)
    await openList()
    await userEvent.type(screen.getByRole('searchbox'), 'alpha')
    await waitFor(() => { expect(router.state.location.search).toBe('?view=contacted&q=alpha'); })
    const list = await openList()
    expect(within(list).getAllByRole('listitem')).toHaveLength(1)
    expect(within(list).getByText('Jean Exemple')).toBeInTheDocument()
    expect(lastListParams(api.requests)).toMatchObject({ category: 'contacted', q: 'alpha' })
  })

  it('reports an empty search', async () => {
    stubContactApi({ rows: rows() })
    renderApp('/contact?view=contacted&q=inexistant')
    expect(await screen.findByText('Aucun prospect ne correspond à la recherche.')).toBeInTheDocument()
  })

  it('paginates beyond the API page size and resets pagination when searching', async () => {
    const people = Array.from({ length: 201 }, (_, index) => contactRow('Jean', `Exemple ${String(index)}`, { messages: { contact: 'sent' } }))
    const api = stubContactApi({ rows: people })
    const { router } = renderApp(CONTACTED)
    const list = await openList()
    expect(within(list).getAllByRole('listitem')).toHaveLength(200)
    await userEvent.click(screen.getByRole('button', { name: 'Page suivante' }))
    await waitFor(() => { expect(within(list).getAllByRole('listitem')).toHaveLength(1); })
    expect(lastListParams(api.requests)).toMatchObject({ offset: '200' })
    await userEvent.type(screen.getByRole('searchbox'), 'Exemple 0')
    await waitFor(() => { expect(router.state.location.search).toBe('?view=contacted&q=Exemple+0'); })
    await waitFor(() => { expect(lastListParams(api.requests)).toMatchObject({ offset: '0', q: 'Exemple 0' }); })
    expect(screen.queryByRole('button', { name: 'Page suivante' })).not.toBeInTheDocument()
  })

  it('keeps old cohort links usable without showing a cohort category', async () => {
    stubContactApi({ rows: rows() })
    renderApp('/contact?section=S39')
    expect(await openList('Prospects à contacter')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /^S39/ })).not.toBeInTheDocument()
  })

  it('keeps the former contacted-section bookmark opening the contacted list', async () => {
    stubContactApi({ rows: rows() })
    renderApp('/contact?section=CONTACTES')
    expect(await openList('Prospects contactés')).toBeInTheDocument()
  })

  it('shows a counters failure with a retry button', async () => {
    stubContactApi({ dashboard: 'error' })
    renderApp(CONTACTED)
    await waitFor(() => {
      const text = screen.getAllByRole('alert').map((alert) => alert.textContent).join(' ')
      expect(text).toContain('Compteurs indisponibles')
      expect(text).toContain('Graphique indisponible')
    })
    expect(within(screen.getByRole('navigation', { name: 'Suivi commercial' })).getByRole('button', { name: 'Réessayer' })).toBeInTheDocument()
  })

  it('opens the workbench and walks the contacted prospects; Back returns to the list', async () => {
    const people = rows().slice(0, 2)
    const [jean, claire] = people as [ReturnType<typeof contactRow>, ReturnType<typeof contactRow>]
    const { prospectDetail } = await import('../test/prospectsApi')
    stubContactApi({
      rows: people,
      details: [prospectDetail({ id: jean.id, first_name: 'Jean', last_name: 'Exemple', civility: 'mr' })],
      messages: { [jean.id]: { contact: message('contact', 'sent') } },
    })
    const { router } = renderApp(CONTACTED)
    const list = await openList()
    await userEvent.click(within(list).getByRole('link', { name: 'Jean Exemple' }))
    expect(await screen.findByRole('heading', { level: 2, name: /Jean Exemple/ })).toBeInTheDocument()
    expect(await screen.findByText('1 sur 2')).toBeInTheDocument()
    expect(router.state.location.search).toBe(`?view=contacted&prospect=${jean.id}`)
    await userEvent.click(screen.getByRole('button', { name: 'Suivant' }))
    await waitFor(() => { expect(router.state.location.search).toContain(`prospect=${claire.id}`); })
    expect(router.state.historyAction).toBe('REPLACE')
    await userEvent.click(screen.getByRole('button', { name: 'Retour à la liste' }))
    expect(await openList()).toBeInTheDocument()
    expect(router.state.location.search).toBe('?view=contacted')
    expect(router.state.historyAction).toBe('POP')
  })

  it('hides old chart date markers while keeping category labels', async () => {
    const overview = contactOverview()
    overview.bars = overview.bars.map((bar, slot) => (slot === 0 ? { ...bar, send_date: '2026-10-05' } : bar))
    const api = stubContactApi({ rows: rows(), overview })
    renderApp(CONTACTED)
    expect(await screen.findByRole('region', { name: 'Graphique des contacts' })).toBeVisible()
    expect(screen.queryByText('05/10/2026')).not.toBeInTheDocument()
    expect(screen.queryByText('Aucun repère')).not.toBeInTheDocument()
    expect(document.querySelector('.contacts-chart input[type="date"]')).toBeNull()
    expect(sent(api.requests, 'PUT', '/api/contact/chart-dates/0')).toHaveLength(0)
  })

  it('filters by company and real commercial state, then resets all criteria', async () => {
    const id = '0192aaaa-0000-7000-8000-000000000001'
    const people = rows().map((row, index) => ({ ...row, company_id: index === 0 ? id : null }))
    const api = stubContactApi({ rows: people })
    const { router } = renderApp(CONTACTED)
    await openList()
    await userEvent.click(screen.getByText('Filtres', { selector: 'summary' }))
    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Entreprise' }), id)
    await waitFor(() => {
      expect(lastListParams(api.requests)).toMatchObject({ company: id })
    })
    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Statut de contact' }), 'state:appointment_obtained')
    expect(await screen.findByText('Aucun prospect ne correspond à la recherche.')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Tout effacer' }))
    await waitFor(() => { expect(router.state.location.search).toBe('?view=contacted') })
    expect(within(await openList()).getAllByRole('listitem')).toHaveLength(4)
  })

  it('filters by the prospect validation status, kept in the URL and sent to the API', async () => {
    const api = stubContactApi({ rows: rows() })
    const { router } = renderApp(CONTACTED)
    await openList()
    await userEvent.click(screen.getByText('Filtres', { selector: 'summary' }))
    await userEvent.click(screen.getByRole('button', { name: 'À vérifier' }))
    await waitFor(() => { expect(router.state.location.search).toBe('?view=contacted&validation=todo') })
    await waitFor(() => { expect(lastListParams(api.requests)).toMatchObject({ verification_box: 'todo' }) })
    expect(within(screen.getByRole('group', { name: 'Filtres appliqués' })).getByText('À vérifier')).toBeVisible()
  })

  it('loads full details only when the row expands and offers existing actions', async () => {
    const row = contactRow('Jean', 'Exemple', { messages: { contact: 'sent' } })
    const { prospectDetail } = await import('../test/prospectsApi')
    const api = stubContactApi({ rows: [row], details: [prospectDetail({ id: row.id, first_name: row.first_name, last_name: row.last_name })] })
    renderApp(CONTACTED)
    await openList()
    expect(screen.queryByRole('region', { name: 'Fiche de Jean Exemple' })).not.toBeInTheDocument()
    expect(sent(api.prospects.requests, 'GET', `/api/prospects/${row.id}`)).toHaveLength(0)
    await userEvent.click(screen.getByRole('button', { name: 'Détails de Jean Exemple' }))
    const details = await screen.findByRole('region', { name: 'Fiche de Jean Exemple' })
    expect(await within(details).findByText('Informations du prospect')).toBeInTheDocument()
    expect(within(details).getByRole('link', { name: 'Modifier la fiche' })).toHaveAttribute('href', `/prospection?prospect=${row.id}`)
    await userEvent.click(screen.getByRole('button', { name: 'Détails de Jean Exemple' }))
    expect(screen.queryByRole('region', { name: 'Fiche de Jean Exemple' })).not.toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Actions de Jean Exemple' }))
    expect(await screen.findByRole('menuitem', { name: 'Ouvrir le suivi' })).toBeInTheDocument()
  })
})
