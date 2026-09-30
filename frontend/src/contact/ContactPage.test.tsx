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

  it('says why the list is empty, and lets failed reads be retried', async () => {
    stubContactApi({ dashboard: DASHBOARD, rows: [] })
    renderApp('/contact')
    expect(await screen.findByText(/Aucun prospect planifié cette semaine/)).toBeInTheDocument()
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

    await userEvent.click(screen.getByRole('button', { name: 'Retour à la liste' }))
    expect(await screen.findByRole('list', { name: 'Prospects à contacter' })).toBeInTheDocument()
    expect(router.state.location.search).toBe('?week=all')
  })
})
