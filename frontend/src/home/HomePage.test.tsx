import { screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { WeeklySeries } from '../api/metrics'
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
const week = (index: number, first_contacts: number, follow_ups: number, appointments: number) => ({
  week: `2026-W${String(42 + index)}`, week_start: `2026-10-${String(12 + 7 * index)}`, week_end: `2026-10-${String(18 + 7 * index)}`,
  additions: { prospects: index, companies: 1, warehouses: 0 }, base: { prospects: 100 + index, companies: 50, warehouses: 10 },
  first_contacts, follow_ups, appointments, ignored: 1,
})
const SERIES: WeeklySeries = {
  timezone: 'Europe/Paris', today: '2026-10-30',
  weeks: [week(0, 10, 2, 1), week(1, 20, 5, 2)],
  totals: { contacted: 200, with_appointment: 8, base_appointment: 8, base_ignored: 30, base_contacted: 162, base_not_contacted: 300 },
}
const API = {
  ...SHELL_API,
  'GET /api/metrics/weekly': [200, METRICS],
  'GET /api/metrics/weekly-series': [200, SERIES],
  'GET /api/prospection/counters': [200, prospectionCounters(17)],
  'GET /api/missions': [200, MISSIONS],
} as const

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-10-30T10:00:00+01:00'))
})
afterEach(() => { vi.useRealTimers() })

describe('Home cockpit', () => {
  it('draws the charts under the cards from the weekly series, with exact rates', async () => {
    stubApi({ ...API })
    renderApp('/')
    const main = within(await screen.findByRole('main'))
    const conversion = await main.findByRole('region', { name: 'Conversion des prospects contactés' })
    expect(within(conversion).getByRole('group', { name: /Rendez-vous \/ contacts : 4\s?% \(8 sur 200\)/ })).toBeInTheDocument()
    const base = main.getByRole('region', { name: 'Répartition de la base' })
    expect(within(base).getByRole('img', { name: /Non contactés : 300/ })).toBeInTheDocument()
    const activity = main.getByRole('region', { name: 'Activité de contact par semaine' })
    expect(within(activity).getByRole('table', { name: 'Activité de contact par semaine' })).toBeInTheDocument()
    expect(main.getByRole('region', { name: 'Croissance de la base par semaine' })).toBeInTheDocument()
    const cards = main.getByRole('list', { name: 'Indicateurs' })
    expect(cards.compareDocumentPosition(activity) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })


  it('shows the data-backed cards of Prospection, Contact and Missions and no visible detail table', async () => {
    stubApi({ ...API })
    renderApp('/')
    const main = within(await screen.findByRole('main'))
    await main.findByRole('link', { name: /Entrepôts/ })
    const list = within(main.getByRole('list', { name: 'Indicateurs' }))
    const cards = list.getAllByRole('link').map((link) => link.textContent.replace(/\s+/g, ' ').trim())
    const has = (label: string, value: string, note?: string) =>
      cards.some((text) => text.includes(label) && text.includes(value) && (note === undefined || text.includes(note)))
    expect([
      has('Prospects', '1 051', '+28 cette semaine'), has('Entreprises', '812', '+12 cette semaine'), has('Entrepôts', '36', '+145 cette semaine'),
      has('Rendez-vous pris', '6', '+'), has('Missions en cours', '2'), has('Résultats à vérifier', '7'),
    ]).toEqual(Array(6).fill(true))
    // The removed counters are charts now: no card, same figures in the « À traiter » bars.
    for (const gone of [/^À contacter/, /^Relances dues/, /^Incomplets/, /^Missions terminées/, /Reviews en attente/]) expect(list.queryByRole('link', { name: gone })).toBeNull()
    expect(list.getAllByRole('listitem')).toHaveLength(6)
    const pipeline = within(main.getByRole('region', { name: 'À traiter' }))
    expect(pipeline.getByRole('link', { name: /À contacter : 41/ })).toBeInTheDocument()
    expect(pipeline.getByRole('link', { name: /Relances dues : 9 \(Dans les temps : 6, En retard : 3\)/ })).toBeInTheDocument()
    expect(pipeline.getByRole('link', { name: /Fiches incomplètes : 17/ })).toBeInTheDocument()
    const missions = within(main.getByRole('region', { name: 'Missions par statut' }))
    expect(missions.getByRole('img', { name: /Active : 2, Inactive : 0, Terminée : 1, Annulée : 0/ })).toBeInTheDocument()
    // The only tables are the visually hidden data of the charts, one per chart (activity + growth).
    expect(await main.findAllByRole('table')).toHaveLength(2)
  })

  it('leads every card through the central descriptors', async () => {
    stubApi({ ...API })
    renderApp('/')
    const main = within(await screen.findByRole('main'))
    await main.findByRole('link', { name: /Prospects/ })
    const href = (name: RegExp) => main.getByRole('link', { name }).getAttribute('href')
    expect(href(/Prospects/)).toBe('/prospection?entity=prospect')
    expect(href(/Entreprises/)).toBe('/prospection?entity=company')
    expect(href(/Entrepôts/)).toBe('/prospection?entity=warehouse')
    expect(href(/Rendez-vous pris/)).toBe('/contact?view=appointments')
    expect(href(/Résultats à vérifier/)).toBe('/missions')
    expect(href(/Missions en cours/)).toBe('/missions')
    // The charts lead where the removed cards led.
    expect(href(/À contacter : 41/)).toBe('/contact?view=to_contact')
    expect(href(/Relances dues : 9/)).toBe('/contact?view=follow_ups')
    expect(href(/Fiches incomplètes : 17/)).toBe('/prospection?entity=prospect&review=incomplete')
    expect(href(/Terminée : 1/)).toBe('/missions')
    expect(screen.getByRole('link', { name: 'Importer Excel' })).toHaveAttribute('href', '/prospection/import')
    expect(screen.getByRole('link', { name: 'Ouvrir la prospection' })).toHaveAttribute('href', '/prospection')
  })

  it('uses the current user date in French and shows true zeros', async () => {
    stubApi({ ...SHELL_API })
    renderApp('/')
    expect(screen.getByText(/vendredi 30 octobre 2026/)).toBeInTheDocument()
    expect(await screen.findByRole('link', { name: /Rendez-vous priss*0/ })).toBeInTheDocument()
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
    expect(await screen.findByRole('link', { name: /Rendez-vous pris/ })).toBeInTheDocument()
    expect(screen.queryByRole('link', { name: /Missions en cours/ })).not.toBeInTheDocument()
    failed = false
    await userEvent.click(screen.getByRole('button', { name: 'Réessayer' }))
    expect(await screen.findByRole('link', { name: /Missions en courss*2/ })).toBeInTheDocument()
  })
})
