import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'

import { contactDashboard, contactRow, CURRENT_WEEK, message, sent, stubContactApi } from '../test/contactApi'
import { renderApp } from '../test/render'

const LIST = '/api/contact/prospects'

function counter(label: string) {
  return within(screen.getByRole('region', { name: 'Compteurs' })).getByRole('button', { name: new RegExp(`^${label}`) })
}

function lastListParams(requests: ReturnType<typeof stubContactApi>['requests']): Record<string, string> {
  const request = sent(requests, 'GET', LIST).at(-1)
  return Object.fromEntries(new URLSearchParams(request?.search ?? ''))
}

const DASHBOARD = contactDashboard({
  counts: { to_handle: 3, first_contact: 1, follow_up: 1, review: 1, appointments: 2 },
  weeks: [
    { week: '2026-W39', year: 2026, number: 39, count: 1 },
    { week: CURRENT_WEEK, year: 2026, number: 40, count: 2 },
    { week: '2026-W42', year: 2026, number: 42, count: 1 },
  ],
})

function rows() {
  return [
    contactRow('Jean', 'Exemple', { civility: 'mr', role_label: 'Responsable transport' }),
    contactRow('Claire', 'Démo', {
      tracking_status: 'contacted',
      next_step: 'r1',
      next_action_week: '2026-W39',
      messages: { contact: 'sent', r1: 'draft', r2: null },
    }),
    contactRow('Luc', 'Fictif', {
      tracking_status: 'appointment_obtained',
      next_step: null,
      due: false,
      next_action_week: null,
      planned_contact_at: null,
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
    await waitFor(() => {
      expect(counter('À traiter cette semaine')).toHaveTextContent('0')
    })
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('shows the counters and lists this week by default (the server’s current week is sent)', async () => {
    const api = stubContactApi({ dashboard: DASHBOARD, rows: rows() })
    renderApp('/contact')

    await waitFor(() => {
      expect(counter('À traiter cette semaine')).toHaveTextContent('3')
    })
    expect(counter('Premier contact')).toHaveTextContent('1')
    expect(counter('Relances')).toHaveTextContent('1')
    expect(counter('Revues R2')).toHaveTextContent('1')
    expect(counter('RDV pris')).toHaveTextContent('2')
    await waitFor(() => {
      expect(lastListParams(api.requests)).toMatchObject({ week: CURRENT_WEEK })
    })
    expect(screen.getByRole('combobox', { name: 'Semaine' })).toHaveValue('current')
    expect(screen.getByText('Prospects dont la prochaine action tombe cette semaine (S40).')).toBeInTheDocument()
  })

  it('filters the list with a counter card, kept in the URL, on every week; pressing it again returns', async () => {
    const api = stubContactApi({ dashboard: DASHBOARD, rows: rows() })
    const { router } = renderApp('/contact')
    await waitFor(() => {
      expect(counter('Relances')).toHaveTextContent('1')
    })

    await userEvent.click(counter('Relances'))
    expect(counter('Relances')).toHaveAttribute('aria-pressed', 'true')
    expect(router.state.location.search).toBe('?counter=follow_up&week=all')
    await waitFor(() => {
      expect(lastListParams(api.requests)).toEqual({ counter: 'follow_up', limit: '50', offset: '0' })
    })
    const list = await screen.findByRole('list', { name: 'Prospects à contacter' })
    expect(within(list).getAllByRole('listitem')).toHaveLength(1)
    expect(screen.getByRole('heading', { level: 2, name: /Relances/ })).toBeInTheDocument()
    expect(screen.getByRole('combobox', { name: 'Semaine' })).toHaveValue('all')

    await userEvent.click(counter('Relances'))
    expect(router.state.location.search).toBe('')
  })

  it('narrows by week and state from the toolbar', async () => {
    const api = stubContactApi({ dashboard: DASHBOARD, rows: rows() })
    renderApp('/contact')
    const week = screen.getByRole('combobox', { name: 'Semaine' })
    await waitFor(() => {
      expect(within(week).getAllByRole('option')).toHaveLength(4)
    })
    expect(within(week).getAllByRole('option').map((option) => option.textContent)).toEqual([
      'Cette semaine (S40)',
      'Toutes les semaines',
      'S39 · lun. 21 sept. 2026 (1)',
      'S42 · lun. 12 oct. 2026 (1)',
    ])
    await userEvent.selectOptions(week, '2026-W42')
    await waitFor(() => {
      expect(lastListParams(api.requests)).toMatchObject({ week: '2026-W42' })
    })
    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'État' }), 'r1')
    await waitFor(() => {
      expect(lastListParams(api.requests)).toMatchObject({ week: '2026-W42', state: 'r1' })
    })
    expect(within(screen.getByRole('combobox', { name: 'État' })).queryByRole('option', { name: 'Ignoré' })).not.toBeInTheDocument()
  })

  it('shows each person with state, week, what to prepare and the three messages', async () => {
    stubContactApi({ dashboard: DASHBOARD, rows: rows() })
    renderApp('/contact?week=all')
    const list = await screen.findByRole('list', { name: 'Prospects à contacter' })
    const [jean, claire, luc] = within(list).getAllByRole('listitem') as [HTMLElement, HTMLElement, HTMLElement]

    expect(jean).toHaveTextContent('Responsable transport')
    expect(jean).toHaveTextContent('À préparer : Premier contact')
    expect(jean).toHaveTextContent('Aucun message préparé')
    expect(within(jean).queryByText(/État :/)).not.toBeInTheDocument()

    expect(claire).toHaveTextContent('État : Contacté')
    expect(claire).toHaveTextContent('Échu')
    expect(claire).toHaveTextContent('À préparer : Relance R1')
    expect(claire).toHaveTextContent(/ContactEnvoyé/)
    expect(claire).toHaveTextContent(/R1Brouillon/)
    expect(claire).toHaveTextContent(/R2Vide/)

    expect(luc).toHaveTextContent('État : RDV pris')
    expect(luc).not.toHaveTextContent('À préparer')
    expect(luc).toHaveTextContent(/ContactAnnulé/)
  })

  it('says why this week is empty, and points to overdue people when « À traiter » has some', async () => {
    stubContactApi({ dashboard: contactDashboard(), rows: [] })
    renderApp('/contact')
    expect(await screen.findByText(/Aucun prospect planifié cette semaine/)).toBeInTheDocument()
  })

  it('points an empty week to « À traiter » when overdue people remain', async () => {
    const overdue = contactRow('Paul', 'Retard', { next_action_week: '2026-W38' })
    stubContactApi({ dashboard: DASHBOARD, rows: [overdue] })
    const { router } = renderApp('/contact')
    expect(await screen.findByText(/3 prospects de semaines passées restent à traiter/)).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Voir « À traiter cette semaine »' }))
    expect(router.state.location.search).toBe('?counter=to_handle&week=all')
    expect(await screen.findByRole('link', { name: 'Paul Retard' })).toBeInTheDocument()
  })

  it('shows the current week of a URL as « Cette semaine »', async () => {
    stubContactApi({ dashboard: DASHBOARD, rows: rows() })
    renderApp(`/contact?week=${CURRENT_WEEK}`)
    await waitFor(() => {
      expect(screen.getByRole('combobox', { name: 'Semaine' })).toHaveValue('current')
    })
  })

  it('clears the state filter when a counter card is pressed (the card equals its list)', async () => {
    stubContactApi({ dashboard: DASHBOARD, rows: rows() })
    const { router } = renderApp('/contact?state=r1')
    await waitFor(() => {
      expect(counter('Relances')).toHaveTextContent('1')
    })
    await userEvent.click(counter('Relances'))
    expect(router.state.location.search).toBe('?counter=follow_up&week=all')
    expect(screen.getByRole('combobox', { name: 'État' })).toHaveValue('')
  })

  it('shows a counters failure with « Réessayer »', async () => {
    stubContactApi({ dashboard: 'error' })
    renderApp('/contact')
    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('Compteurs indisponibles')
    expect(within(alert).getByRole('button', { name: 'Réessayer' })).toBeInTheDocument()
  })

  it('opens the workbench in place of the list; Back returns to the list', async () => {
    const people = rows()
    const [jean] = people as [ReturnType<typeof contactRow>]
    const { prospectDetail } = await import('../test/prospectsApi')
    stubContactApi({
      dashboard: DASHBOARD,
      rows: people,
      details: [prospectDetail({ id: jean.id, first_name: 'Jean', last_name: 'Exemple', civility: 'mr' })],
      messages: { [jean.id]: { contact: message('contact', 'draft') } },
    })
    const { router } = renderApp('/contact?week=all')
    const list = await screen.findByRole('list', { name: 'Prospects à contacter' })
    await userEvent.click(within(list).getByRole('link', { name: 'Jean Exemple' }))

    expect(await screen.findByRole('heading', { level: 2, name: /Jean Exemple/ })).toBeInTheDocument()
    expect(screen.queryByRole('list', { name: 'Prospects à contacter' })).not.toBeInTheDocument()
    expect(screen.getByText('1 sur 3')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Précédent' })).toBeDisabled()
    expect(router.state.location.search).toContain(`prospect=${jean.id}`)

    await userEvent.click(screen.getByRole('button', { name: 'Suivant' }))
    await waitFor(() => {
      expect(router.state.location.search).toContain(`prospect=${people[1]?.id ?? ''}`)
    })
    // The walk replaces the entry: Back never reopens a prospect that was left.
    expect(router.state.historyAction).toBe('REPLACE')

    await userEvent.click(screen.getByRole('button', { name: 'Retour à la liste' }))
    expect(await screen.findByRole('list', { name: 'Prospects à contacter' })).toBeInTheDocument()
    expect(router.state.location.search).toBe('?week=all')
    // « Retour à la liste » goes back to the list's own entry (no new entry that Back would undo).
    expect(router.state.historyAction).toBe('POP')
  })

  it('walks the whole list order past its first page, kept while the workbench is open', async () => {
    const { prospectDetail } = await import('../test/prospectsApi')
    const people = Array.from({ length: 60 }, (_, index) => contactRow('Personne', `N${String(index + 1).padStart(2, '0')}`))
    const fiftieth = people[49] as ReturnType<typeof contactRow>
    const fiftyFirst = people[50] as ReturnType<typeof contactRow>
    stubContactApi({
      dashboard: DASHBOARD,
      rows: people,
      details: [fiftieth, fiftyFirst].map((row) => prospectDetail({ id: row.id, first_name: 'Personne', last_name: row.last_name })),
    })
    const { router } = renderApp(`/contact?week=all&prospect=${fiftieth.id}`)
    expect(await screen.findByText('50 sur 60')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Suivant' }))
    await waitFor(() => {
      expect(router.state.location.search).toContain(fiftyFirst.id)
    })
    expect(await screen.findByText('51 sur 60')).toBeInTheDocument()
    expect(await screen.findByRole('heading', { level: 2, name: /N51/ })).toHaveFocus()
  })
})
