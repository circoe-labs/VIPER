import { screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'

import { SHELL_API } from '../test/homeApi'
import { renderApp, stubApi, TEST_USER } from '../test/render'

const LABELS = ['Accueil', 'Prospection', 'Contact', 'Entrepôts', 'Missions', 'Agenda', 'Organisation']
// TEST_USER is an administrator: the Administration group follows the main and configuration ones.
const ADMIN_LABELS = ['Catégories de mission', 'Skills', 'Sources', 'Base de données', 'Historique agents', 'Paramètres', 'Config AI']
// The Database page lists its tables on load.
const DATABASE_API = { 'GET /api/health': [200, { status: 'ok', database: 'ok' }], 'GET /api/explorer/tables': [200, []] } as const

function navigation() {
  return screen.getByRole('navigation', { name: 'Navigation principale' })
}

describe('AppShell', () => {
  it('lists the sections in French, grouped main / configuration / administration', () => {
    stubApi(SHELL_API)
    renderApp()

    const links = within(navigation()).getAllByRole('link')
    expect(links.map((link) => link.textContent)).toEqual([...LABELS, ...ADMIN_LABELS])
  })

  it('names the three groups of the sidebar', () => {
    stubApi(SHELL_API)
    renderApp()

    const groups = within(navigation()).getAllByRole('list')
    expect(groups.map((group) => group.getAttribute('aria-labelledby'))).toEqual([
      'nav-group-main',
      'nav-group-configuration',
      'nav-group-admin',
    ])
    expect(within(navigation()).getByText('Administration')).toBeInTheDocument()
  })

  it('hides the Administration group from a non-administrator and sends them away from its routes', async () => {
    stubApi(SHELL_API)
    const member = { ...TEST_USER, role: 'member' as const }
    renderApp('/administration/categories', { session: { status: 'authenticated', user: member } })

    expect(await screen.findByRole('heading', { level: 1, name: 'Accueil' })).toBeInTheDocument()
    const links = within(navigation()).getAllByRole('link')
    expect(links.map((link) => link.textContent)).toEqual(LABELS)
    expect(within(navigation()).queryByText('Administration')).not.toBeInTheDocument()
  })

  it('renders the requested route and marks it as current', () => {
    stubApi(DATABASE_API)
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
    stubApi(SHELL_API)
    renderApp()

    await userEvent.click(within(navigation()).getByRole('link', { name: 'Paramètres' }))

    expect(screen.getByRole('heading', { level: 1, name: 'Paramètres' })).toBeInTheDocument()
  })

  it('redirects unknown paths to Accueil', () => {
    stubApi(SHELL_API)
    renderApp('/nope')

    expect(screen.getByRole('heading', { level: 1, name: 'Accueil' })).toBeInTheDocument()
  })

  it('has no help block, API status or footer in the sidebar, and the rail toggle sits next to the logo', () => {
    stubApi(SHELL_API)
    const { container } = renderApp()

    expect(screen.queryByText('Aide')).not.toBeInTheDocument()
    expect(screen.queryByText(/^API :/)).not.toBeInTheDocument()
    expect(container.querySelector('.sidebar__footer')).toBeNull()
    expect(container.querySelector('.sidebar__brand')).toContainElement(
      screen.getByRole('button', { name: 'Réduire la navigation' }),
    )
  })

  it('folds each group on its own', async () => {
    stubApi(SHELL_API)
    renderApp()

    await userEvent.click(screen.getByRole('button', { name: 'Configuration' }))

    expect(within(navigation()).queryByRole('link', { name: 'Organisation' })).not.toBeInTheDocument()
    expect(within(navigation()).getByRole('link', { name: 'Accueil' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Configuration' })).toHaveAttribute('aria-expanded', 'false')
  })

  it('shows the lockup, then the mark once the sidebar is collapsed, and remembers it', async () => {
    stubApi(DATABASE_API)
    const { unmount } = renderApp('/database')

    expect(screen.getByRole('img', { name: 'VIPER' })).toHaveAttribute('src', expect.stringMatching(/viper-lockup-white/))
    const toggle = screen.getByRole('button', { name: 'Réduire la navigation' })
    expect(toggle).toHaveAttribute('aria-expanded', 'true')

    await userEvent.click(toggle)

    expect(screen.getByRole('img', { name: 'VIPER' })).toHaveAttribute('src', expect.stringMatching(/viper-mark-white/))
    expect(screen.getByRole('button', { name: 'Déplier la navigation' })).toHaveAttribute('aria-expanded', 'false')
    const links = within(navigation()).getAllByRole('link')
    expect(links.map((link) => link.textContent)).toEqual([...LABELS, ...ADMIN_LABELS])
    expect(within(navigation()).getByRole('link', { name: 'Base de données' })).toHaveAttribute('aria-current', 'page')

    unmount()
    renderApp('/database')
    expect(screen.getByRole('button', { name: 'Déplier la navigation' })).toBeInTheDocument()
  })

  it('switches the logo to the dark-on-light variant with the light theme', async () => {
    stubApi(SHELL_API)
    renderApp()

    await userEvent.click(screen.getByRole('button', { name: 'Passer au thème clair' }))

    expect(screen.getByRole('img', { name: 'VIPER' })).toHaveAttribute('src', expect.stringMatching(/viper-lockup-black/))
  })
})
