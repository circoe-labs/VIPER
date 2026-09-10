import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'

import { renderApp, stubApi, TEST_USER } from '../test/render'
import type { SessionState } from './session'

const ANONYMOUS: SessionState = { status: 'anonymous', reason: 'initial' }
const SIGNED_IN = [200, { user: TEST_USER, csrf_token: 'csrf-du-serveur' }] as const

function emailField() {
  return screen.getByRole('textbox', { name: 'Adresse e-mail' })
}

function passwordField(): HTMLInputElement {
  return screen.getByLabelText('Mot de passe')
}

async function submit(email: string, password: string) {
  if (email) await userEvent.type(emailField(), email)
  if (password) await userEvent.type(passwordField(), password)
  await userEvent.click(screen.getByRole('button', { name: 'Se connecter' }))
}

describe('LoginPage', () => {
  it('shows the theme lockup, labelled fields and focuses the email', () => {
    renderApp('/login', { session: ANONYMOUS })

    expect(screen.getByRole('heading', { level: 1, name: 'Connexion' })).toBeInTheDocument()
    expect(screen.getByRole('img', { name: 'VIPER' })).toHaveAttribute('src', expect.stringMatching(/viper-lockup-white/))
    expect(emailField()).toHaveFocus()
    expect(emailField()).toHaveAttribute('autocomplete', 'username')
    expect(passwordField()).toHaveAttribute('type', 'password')
    expect(passwordField()).toHaveAttribute('autocomplete', 'current-password')
  })

  it('asks for missing fields in French without calling the API', async () => {
    const fetchMock = stubApi({})
    renderApp('/login', { session: ANONYMOUS })

    await submit('', '')

    expect(screen.getByText('Saisissez votre adresse e-mail.')).toBeInTheDocument()
    expect(screen.getByText('Saisissez votre mot de passe.')).toBeInTheDocument()
    expect(emailField()).toHaveAttribute('aria-invalid', 'true')
    expect(emailField()).toHaveFocus()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('signs in and continues to the page that was asked for', async () => {
    const fetchMock = stubApi({
      'GET /api/auth/session': [401, { detail: 'Not authenticated.' }],
      'POST /api/auth/login': SIGNED_IN,
      'GET /api/health': [200, { status: 'ok', database: 'ok' }],
    })
    const { router } = renderApp('/database?vue=tables', { session: 'fetch' })

    expect(await screen.findByRole('heading', { level: 1, name: 'Connexion' })).toBeInTheDocument()
    await submit('  pilote.test@example.com ', 'mot-de-passe-de-test')

    expect(await screen.findByRole('heading', { level: 1, name: 'Base de données' })).toBeInTheDocument()
    expect(router.state.location).toMatchObject({ pathname: '/database', search: '?vue=tables' })
    expect(screen.getByText('Pilote Test')).toBeInTheDocument()
    expect(fetchMock).toHaveBeenCalledWith('/api/auth/login', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({ email: 'pilote.test@example.com', password: 'mot-de-passe-de-test' }),
    }))
  })

  it('shows one generic error, clears the password and focuses it when sign-in is refused', async () => {
    stubApi({ 'POST /api/auth/login': [401, { detail: 'Invalid email or password.' }] })
    renderApp('/login', { session: ANONYMOUS })

    await submit('pilote.test@example.com', 'mauvais-mot-de-passe')

    expect(await screen.findByRole('alert')).toHaveTextContent('Adresse e-mail ou mot de passe incorrect.')
    expect(passwordField()).toHaveValue('')
    expect(passwordField()).toHaveFocus()
    expect(emailField()).toHaveValue('pilote.test@example.com')
  })

  it('explains the temporary lock after too many attempts', async () => {
    stubApi({ 'POST /api/auth/login': [429, { detail: 'Too many failed attempts.' }] })
    renderApp('/login', { session: ANONYMOUS })

    await submit('pilote.test@example.com', 'mauvais-mot-de-passe')

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Trop de tentatives de connexion. Réessayez dans quelques minutes.',
    )
  })

  it('shows a busy button while the sign-in is pending', async () => {
    stubApi({ 'POST /api/auth/login': () => new Promise<Response>(() => undefined) })
    renderApp('/login', { session: ANONYMOUS })

    await submit('pilote.test@example.com', 'mot-de-passe-de-test')

    const button = screen.getByRole('button', { name: 'Connexion…' })
    expect(button).toHaveAttribute('aria-busy', 'true')
    expect(button).toBeDisabled()
  })

  it('sends an already signed-in visitor to the app', async () => {
    const { router } = renderApp('/login')

    await waitFor(() => {
      expect(router.state.location.pathname).toBe('/')
    })
    expect(screen.getByRole('heading', { level: 1, name: 'Accueil' })).toBeInTheDocument()
  })
})
