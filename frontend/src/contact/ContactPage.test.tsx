import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'

import { contactDashboard, contactRow, message, sent, stubContactApi } from '../test/contactApi'
import { renderApp } from '../test/render'

const LIST = '/api/contact/prospects'

async function openList() {
  const toggle = await screen.findByRole('button', { name: /^Prospects contactés/ })
  if (toggle.getAttribute('aria-expanded') === 'false') await userEvent.click(toggle)
  return screen.findByRole('list', { name: 'Prospects contactés' })
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
    renderApp('/contact')
    const list = await openList()
    expect(within(list).getByText('Dernier e-mail envoyé')).toBeInTheDocument()
    expect(within(list).getByText('14 septembre 2026')).toBeInTheDocument()
    expect(within(list).queryByText('1 octobre 2026')).not.toBeInTheDocument()
  })
  it('replaces Exploitation in the navigation, and the old path leads to it', async () => {
    stubContactApi({ dashboard: DASHBOARD })
    const { router } = renderApp('/exploitation')
    expect(await screen.findByRole('heading', { level: 1, name: 'Contacts' })).toBeInTheDocument()
    expect(router.state.location.pathname).toBe('/contact')
    const navigation = screen.getByRole('navigation', { name: 'Navigation principale' })
    expect(within(navigation).getByRole('link', { name: 'Contacts' })).toHaveAttribute('aria-current', 'page')
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
    expect(await screen.findByRole('button', { name: /^Prospects contactés/ })).toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('starts with one closed category of contacted prospects, without cohort codes or planning categories', async () => {
    const people = rows()
    people.push(contactRow('Pas', 'Contacté', { messages: { contact: 'scheduled' } }))
    const api = stubContactApi({ dashboard: DASHBOARD, rows: people })
    renderApp('/contact')

    expect(screen.getByRole('button', { name: /^Prospects contactés/ })).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByRole('list', { name: 'Prospects contactés' })).not.toBeInTheDocument()
    expect(sent(api.requests, 'GET', LIST)).toHaveLength(0)

    const list = await openList()
    expect(within(list).getAllByRole('listitem')).toHaveLength(4)
    expect(within(list).queryByText('Pas Contacté')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: /^Prospects contactés/ })).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByRole('button', { name: /^Prospects contactés/ })).toHaveTextContent('4 prospects')
    expect(screen.queryByRole('button', { name: /^S\d/ })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /^RDV pris/ })).not.toBeInTheDocument()
    expect(screen.queryByText('Suivi des envois programmés')).not.toBeInTheDocument()
    expect(lastListParams(api.requests)).toEqual({ category: 'contacted', sort: 'company', limit: '200', offset: '0' })
    expect(sent(api.requests, 'GET', '/api/contact/scheduling')).toHaveLength(0)
  })

  it('keeps contacted people together across cohorts and commercial states', async () => {
    stubContactApi({ dashboard: DASHBOARD, rows: rows() })
    renderApp('/contact')
    const list = await openList()
    expect(within(list).getByText('Jean Exemple')).toBeInTheDocument()
    expect(within(list).getByText('Marie Calme')).toBeInTheDocument()
    expect(within(list).getByText('Luc Fictif')).toBeInTheDocument()
    expect(within(list).getByText('Claire Démo').closest('li')).toHaveTextContent('Relance R1')
  })

  it('can collapse and reopen the category', async () => {
    stubContactApi({ dashboard: DASHBOARD, rows: rows() })
    renderApp('/contact')
    await openList()
    const toggle = screen.getByRole('button', { name: /^Prospects contactés/ })
    await userEvent.click(toggle)
    expect(toggle).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByRole('list', { name: 'Prospects contactés' })).not.toBeInTheDocument()
    await userEvent.click(toggle)
    expect(await openList()).toBeInTheDocument()
  })

  it('explains when no prospect has been contacted yet', async () => {
    stubContactApi({ rows: [contactRow('Jean', 'Nouveau')] })
    renderApp('/contact')
    await userEvent.click(screen.getByRole('button', { name: /^Prospects contactés/ }))
    expect(await screen.findByText('Aucun prospect contacté pour le moment.')).toBeInTheDocument()
  })

  it('searches contacted prospects and keeps the search in the URL', async () => {
    const api = stubContactApi({ dashboard: DASHBOARD, rows: rows() })
    const { router } = renderApp('/contact')
    await openList()
    await userEvent.click(screen.getByRole('button', { name: /^Prospects contactés/ }))
    await userEvent.type(screen.getByRole('searchbox'), 'alpha')
    await waitFor(() => { expect(router.state.location.search).toBe('?q=alpha'); })
    const list = await openList()
    expect(within(list).getAllByRole('listitem')).toHaveLength(1)
    expect(within(list).getByText('Jean Exemple')).toBeInTheDocument()
    expect(lastListParams(api.requests)).toMatchObject({ category: 'contacted', q: 'alpha' })
  })

  it('reports an empty search', async () => {
    stubContactApi({ rows: rows() })
    renderApp('/contact?q=inexistant')
    await userEvent.click(screen.getByRole('button', { name: /^Prospects contactés/ }))
    expect(await screen.findByText('Aucun prospect contacté ne correspond à la recherche.')).toBeInTheDocument()
  })

  it('paginates beyond the API page size and resets pagination when searching', async () => {
    const people = Array.from({ length: 201 }, (_, index) => contactRow('Jean', `Exemple ${String(index)}`, { messages: { contact: 'sent' } }))
    const api = stubContactApi({ rows: people })
    const { router } = renderApp('/contact')
    const list = await openList()
    expect(within(list).getAllByRole('listitem')).toHaveLength(200)
    await userEvent.click(screen.getByRole('button', { name: 'Page suivante' }))
    await waitFor(() => { expect(within(list).getAllByRole('listitem')).toHaveLength(1); })
    expect(lastListParams(api.requests)).toMatchObject({ offset: '200' })
    await userEvent.type(screen.getByRole('searchbox'), 'Exemple 0')
    await waitFor(() => { expect(router.state.location.search).toBe('?q=Exemple+0'); })
    await waitFor(() => { expect(lastListParams(api.requests)).toMatchObject({ offset: '0', q: 'Exemple 0' }); })
    expect(screen.queryByRole('button', { name: 'Page suivante' })).not.toBeInTheDocument()
  })

  it('keeps old cohort links usable without showing a cohort category', async () => {
    stubContactApi({ rows: rows() })
    renderApp('/contact?section=S39')
    expect(await openList()).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /^S39/ })).not.toBeInTheDocument()
  })

  it('shows a counters failure with a retry button', async () => {
    stubContactApi({ dashboard: 'error' })
    renderApp('/contact')
    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('Graphique indisponible')
    expect(within(alert).getByRole('button', { name: 'Réessayer' })).toBeInTheDocument()
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
    const { router } = renderApp('/contact')
    const list = await openList()
    await userEvent.click(within(list).getByRole('link', { name: 'Jean Exemple' }))
    expect(await screen.findByRole('heading', { level: 2, name: /Jean Exemple/ })).toBeInTheDocument()
    expect(await screen.findByText('1 sur 2')).toBeInTheDocument()
    expect(router.state.location.search).toBe(`?section=CONTACTES&prospect=${jean.id}`)
    await userEvent.click(screen.getByRole('button', { name: 'Suivant' }))
    await waitFor(() => { expect(router.state.location.search).toContain(`prospect=${claire.id}`); })
    expect(router.state.historyAction).toBe('REPLACE')
    await userEvent.click(screen.getByRole('button', { name: 'Retour à la liste' }))
    expect(await openList()).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /^Prospects contactés/ })).toHaveAttribute('aria-expanded', 'true')
    expect(router.state.location.search).toBe('')
    expect(router.state.historyAction).toBe('POP')
  })

  it('keeps each chart date independent and reads saved dates on a fresh page', async () => {
    const api = stubContactApi({ rows: rows() })
    const first = renderApp('/contact')
    const date = await screen.findByLabelText('Date d’envoi du graphique — Contact')
    const r1 = screen.getByLabelText('Date d’envoi du graphique — R1')
    expect(date).toHaveValue('')
    expect(r1).toHaveValue('')
    const { fireEvent } = await import('@testing-library/react')
    fireEvent.change(date, { target: { value: '2026-10-05' } })
    fireEvent.blur(date)
    await waitFor(() => {
      expect(sent(api.requests, 'PUT', '/api/contact/chart-dates/0').at(-1)?.body).toEqual({ send_date: '2026-10-05' })
    })
    expect(screen.getByLabelText('Date d’envoi du graphique — R1')).toHaveValue('')
    first.unmount()
    renderApp('/contact')
    expect(await screen.findByLabelText('Date d’envoi du graphique — Contact')).toHaveValue('2026-10-05')
    await userEvent.click(screen.getByRole('button', { name: 'Effacer la date — Contact' }))
    await waitFor(() => {
      expect(screen.getByLabelText('Date d’envoi du graphique — Contact')).toHaveValue('')
    })
  })

  it('filters by company and real commercial state, then resets all criteria', async () => {
    const id = '0192aaaa-0000-7000-8000-000000000001'
    const people = rows().map((row, index) => ({ ...row, company_id: index === 0 ? id : null }))
    const api = stubContactApi({ rows: people })
    const { router } = renderApp('/contact')
    await openList()
    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Entreprise' }), id)
    await waitFor(() => {
      expect(lastListParams(api.requests)).toMatchObject({ company: id })
    })
    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Statut' }), 'state:appointment_obtained')
    expect(await screen.findByText('Aucun prospect contacté ne correspond à la recherche.')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Réinitialiser' }))
    await waitFor(() => { expect(router.state.location.search).toBe('') })
    expect(within(await openList()).getAllByRole('listitem')).toHaveLength(4)
  })

  it('loads full details only when the row expands and offers existing actions', async () => {
    const row = contactRow('Jean', 'Exemple', { messages: { contact: 'sent' } })
    const { prospectDetail } = await import('../test/prospectsApi')
    const api = stubContactApi({ rows: [row], details: [prospectDetail({ id: row.id, first_name: row.first_name, last_name: row.last_name })] })
    renderApp('/contact')
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
