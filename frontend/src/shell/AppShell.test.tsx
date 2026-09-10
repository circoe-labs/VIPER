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

  it('shows the lockup, then the mark once the sidebar is collapsed, and remembers it', async () => {
    stubFetchJson(200, { status: 'ok', database: 'ok' })
    const { unmount } = renderApp('/database')

    expect(screen.getByRole('img', { name: 'VIPER' })).toHaveAttribute('src', expect.stringMatching(/viper-lockup-white/))
    const toggle = screen.getByRole('button', { name: 'Réduire la navigation' })
    expect(toggle).toHaveAttribute('aria-expanded', 'true')

    await userEvent.click(toggle)

    expect(screen.getByRole('img', { name: 'VIPER' })).toHaveAttribute('src', expect.stringMatching(/viper-mark-white/))
    expect(screen.getByRole('button', { name: 'Déplier la navigation' })).toHaveAttribute('aria-expanded', 'false')
    const links = within(navigation()).getAllByRole('link')
    expect(links.map((link) => link.textContent)).toEqual(LABELS)
    expect(within(navigation()).getByRole('link', { name: 'Base de données' })).toHaveAttribute('aria-current', 'page')

    unmount()
    renderApp('/database')
    expect(screen.getByRole('button', { name: 'Déplier la navigation' })).toBeInTheDocument()
  })

  it('switches the logo to the dark-on-light variant with the light theme', async () => {
    stubFetchJson(200, { status: 'ok', database: 'ok' })
    renderApp()

    await userEvent.click(screen.getByRole('button', { name: 'Passer au thème clair' }))

    expect(screen.getByRole('img', { name: 'VIPER' })).toHaveAttribute('src', expect.stringMatching(/viper-lockup-black/))
  })

  it('renders placeholder pages without data', () => {
    stubFetchJson(200, { status: 'ok', database: 'ok' })
    renderApp('/exploitation')

    expect(screen.getByRole('heading', { level: 2, name: 'Bientôt disponible' })).toBeInTheDocument()
    expect(screen.queryByRole('table')).not.toBeInTheDocument()
  })
})
