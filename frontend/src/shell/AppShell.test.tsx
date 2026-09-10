import { screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'

import { renderApp, stubFetchJson } from '../test/render'

const LABELS = ['Accueil', 'Prospection', 'Exploitation', 'Base de données', 'Paramètres']

function navigation() {
  return screen.getByRole('navigation', { name: 'Navigation principale' })
}

describe('AppShell', () => {
  it('lists the five sections in French, in order', () => {
    stubFetchJson(200, { status: 'ok', database: 'ok' })
    renderApp()

    const links = within(navigation()).getAllByRole('link')
    expect(links.map((link) => link.textContent)).toEqual(LABELS)
  })

  it('renders the requested route and marks it as current', () => {
    stubFetchJson(200, { status: 'ok', database: 'ok' })
    renderApp('/database')

    expect(screen.getByRole('heading', { level: 1, name: 'Base de données' })).toBeInTheDocument()
    expect(within(navigation()).getByRole('link', { name: 'Base de données' })).toHaveAttribute(
      'aria-current',
      'page',
    )
    expect(within(navigation()).getByRole('link', { name: 'Accueil' })).not.toHaveAttribute(
      'aria-current',
    )
  })

  it('navigates between sections from the left navigation', async () => {
    stubFetchJson(200, { status: 'ok', database: 'ok' })
    renderApp()

    await userEvent.click(within(navigation()).getByRole('link', { name: 'Paramètres' }))

    expect(screen.getByRole('heading', { level: 1, name: 'Paramètres' })).toBeInTheDocument()
  })

  it('redirects unknown paths to Accueil', () => {
    stubFetchJson(200, { status: 'ok', database: 'ok' })
    renderApp('/nope')

    expect(screen.getByRole('heading', { level: 1, name: 'Accueil' })).toBeInTheDocument()
  })

  it('shows the API as connected when the health probe succeeds', async () => {
    stubFetchJson(200, { status: 'ok', database: 'ok' })
    renderApp()

    expect(await screen.findByText('API : connectée')).toBeInTheDocument()
  })

  it('shows the API as unavailable when the health probe fails', async () => {
    stubFetchJson(503, { status: 'degraded', database: 'unavailable' })
    renderApp()

    expect(await screen.findByText('API : indisponible')).toBeInTheDocument()
  })
})
