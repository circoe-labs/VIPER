import { act, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'

import { apiGet } from '../api/client'
import { type ApiReply, renderApp, stubApi, TEST_USER } from '../test/render'

const HEALTHY: Record<string, ApiReply> = { 'GET /api/health': [200, { status: 'ok', database: 'ok' }] }

describe('RequireAuth', () => {
  it('sends anonymous visitors to the sign-in page without a notice', async () => {
    stubApi({ ...HEALTHY, 'GET /api/auth/session': [401, { detail: 'Not authenticated.' }] })
    const { router } = renderApp('/prospection', { session: 'fetch' })

    expect(await screen.findByRole('heading', { level: 1, name: 'Connexion' })).toBeInTheDocument()
    expect(router.state.location.pathname).toBe('/login')
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
    expect(screen.queryByRole('navigation', { name: 'Navigation principale' })).not.toBeInTheDocument()
  })

  it('restores the session from the server on load', async () => {
    stubApi({ ...HEALTHY, 'GET /api/auth/session': [200, { user: TEST_USER, csrf_token: 'jeton' }] })
    renderApp('/prospection', { session: 'fetch' })

    expect(screen.getByRole('status')).toHaveTextContent('Chargement de votre session…')
    expect(await screen.findByRole('heading', { level: 1, name: 'Prospection' })).toBeInTheDocument()
    expect(screen.getByText('Pilote Test')).toBeInTheDocument()
  })

  it('returns to sign-in with an explanation when an API call answers 401, then back to the same page', async () => {
    stubApi({
      ...HEALTHY,
      'GET /api/protected': [401, { detail: 'Not authenticated.' }],
      'POST /api/auth/login': [200, { user: TEST_USER, csrf_token: 'nouveau-jeton' }],
    })
    const { router } = renderApp('/settings')
    expect(screen.getByRole('heading', { level: 1, name: 'Paramètres' })).toBeInTheDocument()

    await act(() => apiGet('/protected').catch(() => undefined))

    expect(await screen.findByRole('heading', { level: 1, name: 'Connexion' })).toBeInTheDocument()
    expect(screen.getByRole('status')).toHaveTextContent('Votre session a expiré. Reconnectez-vous pour continuer.')

    await userEvent.type(screen.getByRole('textbox', { name: 'Adresse e-mail' }), 'pilote.test@example.com')
    await userEvent.type(screen.getByLabelText('Mot de passe'), 'mot-de-passe-de-test')
    await userEvent.click(screen.getByRole('button', { name: 'Se connecter' }))

    expect(await screen.findByRole('heading', { level: 1, name: 'Paramètres' })).toBeInTheDocument()
    expect(router.state.location.pathname).toBe('/settings')
  })

  it('offers a retry when the server cannot be reached', async () => {
    const replies: Record<string, ApiReply> = { ...HEALTHY, 'GET /api/auth/session': [503, {}] }
    stubApi(replies)
    renderApp('/', { session: 'fetch' })

    expect(await screen.findByRole('alert')).toHaveTextContent('Impossible de joindre le serveur VIPER.')

    replies['GET /api/auth/session'] = [200, { user: TEST_USER, csrf_token: 'jeton' }]
    await userEvent.click(screen.getByRole('button', { name: 'Réessayer' }))

    expect(await screen.findByRole('heading', { level: 1, name: 'Accueil' })).toBeInTheDocument()
  })
})
