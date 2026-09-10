import { screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'

import { type ApiReply, renderApp, stubApi, TEST_CSRF_TOKEN, TEST_USER } from '../test/render'

const HEALTHY: Record<string, ApiReply> = { 'GET /api/health': [200, { status: 'ok', database: 'ok' }] }

describe('UserMenu', () => {
  it('shows who is signed in', () => {
    stubApi(HEALTHY)
    renderApp()

    expect(screen.getByText('Pilote Test')).toHaveTextContent('Connecté : Pilote Test')
    expect(screen.getByText('Pilote Test')).toHaveAttribute('title', TEST_USER.email)
    expect(screen.getByText('PT')).toHaveAttribute('aria-hidden', 'true')
  })

  it('signs out with the CSRF token, forgets cached data and shows the sign-in page', async () => {
    const fetchMock = stubApi({
      ...HEALTHY,
      'POST /api/auth/logout': [204],
      'POST /api/auth/login': [200, { user: TEST_USER, csrf_token: 'nouveau-jeton' }],
    })
    const { router, queryClient } = renderApp('/database')
    await screen.findByText('API : connectée')

    await userEvent.click(screen.getByRole('button', { name: 'Se déconnecter' }))

    expect(await screen.findByRole('heading', { level: 1, name: 'Connexion' })).toBeInTheDocument()
    expect(screen.getByRole('status')).toHaveTextContent('Vous êtes déconnecté.')
    expect(fetchMock).toHaveBeenCalledWith('/api/auth/logout', expect.objectContaining({
      method: 'POST',
      headers: expect.objectContaining({ 'X-CSRF-Token': TEST_CSRF_TOKEN }) as unknown,
    }))
    expect(queryClient.getQueryData(['health'])).toBeUndefined()

    // After an explicit sign-out, signing in again starts from Accueil rather than the last page.
    await userEvent.type(screen.getByRole('textbox', { name: 'Adresse e-mail' }), 'pilote.test@example.com')
    await userEvent.type(screen.getByLabelText('Mot de passe'), 'mot-de-passe-de-test')
    await userEvent.click(screen.getByRole('button', { name: 'Se connecter' }))
    expect(await screen.findByRole('heading', { level: 1, name: 'Accueil' })).toBeInTheDocument()
    expect(router.state.location.pathname).toBe('/')
  })

  it('reports a failed sign-out instead of pretending it worked', async () => {
    stubApi({ ...HEALTHY, 'POST /api/auth/logout': [500, {}] })
    renderApp()

    await userEvent.click(screen.getByRole('button', { name: 'Se déconnecter' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('Déconnexion impossible')
    expect(screen.getByRole('heading', { level: 1, name: 'Accueil' })).toBeInTheDocument()
  })
})
