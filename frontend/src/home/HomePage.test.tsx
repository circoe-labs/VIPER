import { screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { MissionCard } from '../api/missions'
import { prospectionCounters, SHELL_API, weeklyMetrics } from '../test/homeApi'
import { renderApp, stubApi } from '../test/render'

const METRICS = weeklyMetrics({
  week_start: '2026-10-26',
  additions: { prospects: 28, companies: 12, warehouses: 145 },
  contact_stock: { ...weeklyMetrics().contact_stock, appointments: 6, first_contact_to_send: 41, follow_up_to_send: 9, follow_up_overdue: 3 },
})
const mission = (status: MissionCard['status'], results_pending: number) => ({ status, results_pending }) as MissionCard
const MISSIONS = { items: [mission('active', 2), mission('active', 0), mission('done', 5)], total: 3 }
const API = {
  ...SHELL_API,
  'GET /api/metrics/weekly': [200, METRICS],
  'GET /api/prospection/counters': [200, prospectionCounters(17)],
  'GET /api/missions': [200, MISSIONS],
} as const

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-10-30T10:00:00+01:00'))
})
afterEach(() => { vi.useRealTimers() })

describe('Home cockpit', () => {
  it('shows the data-backed cards of Prospection, Contact and Missions and no detail table', async () => {
    stubApi({ ...API })
    renderApp('/')
    const main = within(await screen.findByRole('main'))
    await main.findByRole('link', { name: /145 Nouveaux entrepôts/ })
    const names = main.getAllByRole('link').map((link) => link.getAttribute('aria-label')).filter(Boolean)
    expect(names).toEqual(expect.arrayContaining([
      '+ 28 Nouveaux prospects cette semaine', '+ 12 Nouvelles entreprises cette semaine', '+ 145 Nouveaux entrepôts cette semaine',
      '6 Rendez-vous pris', '41 À contacter', '9 Relances dues dont 3 en retard', '17 À vérifier',
      '2 Missions en cours', '1 Missions terminées', '7 Reviews en attente',
    ]))
    expect(main.queryByRole('table')).not.toBeInTheDocument()
  })

  it('leads every card through the central descriptors', async () => {
    stubApi({ ...API })
    renderApp('/')
    const main = within(await screen.findByRole('main'))
    await main.findByRole('link', { name: /Nouveaux prospects/ })
    const href = (name: RegExp) => main.getByRole('link', { name }).getAttribute('href')
    expect(href(/Nouveaux prospects/)).toBe('/prospection?entity=prospect&created_from=2026-10-26')
    expect(href(/Nouvelles entreprises/)).toBe('/prospection?entity=company&created_from=2026-10-26')
    // No creation-date filter exists for warehouses: the card leads to the list, not to a fake filter.
    expect(href(/Nouveaux entrepôts/)).toBe('/prospection?entity=warehouse')
    expect(href(/Rendez-vous pris/)).toBe('/contact?view=appointments')
    expect(href(/À contacter/)).toBe('/contact?view=to_contact')
    expect(href(/Relances dues/)).toBe('/contact?view=follow_ups')
    expect(href(/À vérifier/)).toBe('/prospection?entity=prospect&review=to_verify')
    expect(href(/Reviews en attente/)).toBe('/missions')
    expect(screen.getByRole('link', { name: 'Importer Excel' })).toHaveAttribute('href', '/prospection/import')
    expect(screen.getByRole('link', { name: 'Ouvrir la prospection' })).toHaveAttribute('href', '/prospection')
  })

  it('uses the current user date in French and shows true zeros', async () => {
    stubApi({ ...SHELL_API })
    renderApp('/')
    expect(screen.getByText(/vendredi 30 octobre 2026/)).toBeInTheDocument()
    expect(await screen.findByRole('link', { name: /0 Rendez-vous pris/ })).toBeInTheDocument()
  })

  it('shows loading and no card rather than zero while unavailable', async () => {
    const pending = () => new Promise<Response>(() => undefined)
    stubApi({ ...SHELL_API, 'GET /api/metrics/weekly': pending, 'GET /api/prospection/counters': pending, 'GET /api/missions': pending })
    renderApp('/')
    expect(await screen.findByText('Chargement des statistiques…')).toBeInTheDocument()
    expect(within(screen.getByRole('main')).queryAllByRole('listitem')).toHaveLength(0)
  })

  it('hides a card whose source failed, reports it, and retries', async () => {
    let failed = true
    stubApi({ ...API, 'GET /api/missions': () => failed ? [500, { detail: 'boom' }] : [200, MISSIONS] })
    renderApp('/')
    expect(await screen.findByRole('alert')).toHaveTextContent('Impossible de charger certaines statistiques de VIPER.')
    expect(await screen.findByRole('link', { name: /17 À vérifier/ })).toBeInTheDocument()
    expect(screen.queryByRole('link', { name: /Missions en cours/ })).not.toBeInTheDocument()
    failed = false
    await userEvent.click(screen.getByRole('button', { name: 'Réessayer' }))
    expect(await screen.findByRole('link', { name: /2 Missions en cours/ })).toBeInTheDocument()
  })
})
