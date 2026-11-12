import { screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { homeDashboard, SHELL_API } from '../test/homeApi'
import { renderApp, stubApi } from '../test/render'

const DATA = homeDashboard({ prospects: 1053, companies: 812, contacted: 189, appointments: 6, new_companies: 12, new_prospects: 28, prospect_trend: [{ week: '2026-10-19', prospects: 10, warehouses: 0 }, { week: '2026-10-26', prospects: 28, warehouses: 145 }] })

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-10-30T10:00:00+01:00'))
})
afterEach(() => { vi.useRealTimers() })

describe('Home dashboard', () => {
  it('shows four counters and the weekly additions chart', async () => {
    stubApi({ ...SHELL_API, 'GET /api/home/dashboard': [200, DATA] })
    renderApp('/')
    const totals = await screen.findByRole('list', { name: 'Chiffres clés' })
    await within(totals).findByRole('link', { name: /1\s053 Prospects/ })
    expect(within(totals).getAllByRole('listitem')).toHaveLength(4)
    expect(within(totals).getAllByRole('link').map((link) => link.textContent)).toEqual(['Prospects1\u202f053', 'Entreprises812', 'Contactés189', 'RDV pris6'])
    expect(screen.getByRole('region', { name: 'Évolution des ajouts' })).toBeInTheDocument()
    expect(screen.getByText(/Semaine dernière/)).toBeInTheDocument()
    expect(screen.getByText(/Cette semaine/)).toBeInTheDocument()
    expect(screen.getByRole('listitem', { name: /28 prospects en prospection, 145 prospects entrepôt/ })).toBeInTheDocument()
    const main = within(screen.getByRole('main'))
    for (const old of ['Base', 'Activité de contact', 'Semaine à contacter', 'Campagne d’envoi', 'Progression du mois', 'Défaillant', 'À vérifier', 'Sans réponse', 'Mail invalide']) expect(main.queryByText(old)).not.toBeInTheDocument()
  })

  it('keeps actions and links every card to its corresponding real view and date filters', async () => {
    stubApi({ ...SHELL_API, 'GET /api/home/dashboard': [200, DATA] })
    renderApp('/')
    await screen.findByRole('region', { name: 'Évolution des ajouts' })
    const totals = within(screen.getByRole('list', { name: 'Chiffres clés' }))
    expect(totals.getByRole('link', { name: /Prospects$/ })).toHaveAttribute('href', '/prospection?list=1')
    expect(totals.getByRole('link', { name: /Entreprises$/ })).toHaveAttribute('href', '/prospection/companies')
    expect(totals.getByRole('link', { name: /Contactés$/ })).toHaveAttribute('href', '/contact?section=CONTACTES')
    expect(totals.getByRole('link', { name: /RDV pris$/ })).toHaveAttribute('href', '/prospection?segment=appointments')
    expect(screen.getByRole('link', { name: 'Importer Excel' })).toHaveAttribute('href', '/prospection/import')
    expect(screen.getByRole('link', { name: 'Ouvrir la prospection' })).toHaveAttribute('href', '/prospection')
  })

  it('uses the current user date in French and shows true zeros with singular labels', async () => {
    stubApi(SHELL_API)
    renderApp('/')
    expect(screen.getByText(/vendredi 30 octobre 2026/)).toBeInTheDocument()
    expect(await screen.findByText('Aucune donnée disponible.')).toBeInTheDocument()
    expect(within(screen.getByRole('list', { name: 'Chiffres clés' })).getAllByRole('link').every((link) => link.textContent.endsWith('0'))).toBe(true)
  })

  it('shows loading placeholders rather than zero for unavailable counters', async () => {
    stubApi({ ...SHELL_API, 'GET /api/home/dashboard': () => new Promise<Response>(() => undefined) })
    renderApp('/')
    expect(await screen.findByText('Chargement des statistiques…')).toBeInTheDocument()
    expect(screen.getAllByText('—')).toHaveLength(4)
    expect(screen.queryByText('+ 0')).not.toBeInTheDocument()
  })

  it('reports a failed read and retries without inventing counts', async () => {
    let failed = true
    stubApi({ ...SHELL_API, 'GET /api/home/dashboard': () => failed ? [500, { detail: 'boom' }] : [200, DATA] })
    renderApp('/')
    expect(await screen.findByRole('alert')).toHaveTextContent('Impossible de charger les statistiques de VIPER.')
    expect(screen.getAllByText('—')).toHaveLength(4)
    failed = false
    await userEvent.click(screen.getByRole('button', { name: 'Réessayer' }))
    expect(await screen.findByRole('listitem', { name: /28 prospects en prospection, 145 prospects entrepôt/ })).toBeInTheDocument()
  })
})
