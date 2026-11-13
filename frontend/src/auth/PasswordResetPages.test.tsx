import { screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'

import { renderApp, stubApi } from '../test/render'
import type { SessionState } from './session'

const ANONYMOUS: SessionState = { status: 'anonymous', reason: 'initial' }
const PASSWORD = 'un nouveau mot de passe'

function bodyOf(fetchMock: ReturnType<typeof stubApi>, suffix: string): unknown {
  const [, init] = fetchMock.mock.calls.find(([url]) => url.endsWith(suffix)) ?? []
  return JSON.parse(init?.body as string)
}

describe('« Mot de passe oublié ? »', () => {
  it('is linked under the password field of the sign-in page', async () => {
    stubApi({})
    renderApp('/login', { session: ANONYMOUS })

    await userEvent.click(screen.getByRole('link', { name: 'Mot de passe oublié ?' }))

    expect(screen.getByRole('heading', { level: 1, name: 'Mot de passe oublié' })).toBeInTheDocument()
  })

  it('asks for the link and gives a neutral confirmation', async () => {
    const fetchMock = stubApi({ 'POST /api/auth/forgot-password': [202, { status: 'sent' }] })
    renderApp('/mot-de-passe-oublie', { session: ANONYMOUS })

    await userEvent.type(screen.getByRole('textbox', { name: /Adresse e-mail/ }), 'marie@circoe.com')
    await userEvent.click(screen.getByRole('button', { name: 'Envoyer le lien' }))

    expect(
      await screen.findByText(
        'Si un compte actif existe pour cette adresse, un e-mail avec un lien de réinitialisation vient d’être envoyé.',
      ),
    ).toBeInTheDocument()
    expect(bodyOf(fetchMock, '/auth/forgot-password')).toEqual({ email: 'marie@circoe.com' })
  })

  it('asks for the address before calling the API', async () => {
    const fetchMock = stubApi({})
    renderApp('/mot-de-passe-oublie', { session: ANONYMOUS })

    await userEvent.click(screen.getByRole('button', { name: 'Envoyer le lien' }))

    expect(screen.getByText('Saisissez votre adresse e-mail.')).toBeInTheDocument()
    expect(fetchMock.mock.calls.some(([url]) => url.endsWith('/auth/forgot-password'))).toBe(false)
  })

  it('says when the requests are throttled', async () => {
    stubApi({ 'POST /api/auth/forgot-password': [429, { detail: 'Too many requests.' }] })
    renderApp('/mot-de-passe-oublie', { session: ANONYMOUS })

    await userEvent.type(screen.getByRole('textbox', { name: /Adresse e-mail/ }), 'marie@circoe.com')
    await userEvent.click(screen.getByRole('button', { name: 'Envoyer le lien' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('Trop de demandes')
  })
})

describe('ResetPasswordPage', () => {
  async function fill(password = PASSWORD, confirm = PASSWORD) {
    await userEvent.type(screen.getByLabelText(/^Nouveau mot de passe/), password)
    await userEvent.type(screen.getByLabelText('Confirmer le mot de passe'), confirm)
    await userEvent.click(screen.getByRole('button', { name: 'Changer le mot de passe' }))
  }

  it('sends the token and the new password, then links to the sign-in page', async () => {
    const fetchMock = stubApi({ 'POST /api/auth/reset-password': [204] })
    renderApp('/reinitialisation/tok-123', { session: ANONYMOUS })

    await fill()

    expect(await screen.findByText(/Mot de passe modifié/)).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Se connecter' })).toHaveAttribute('href', '/login')
    expect(bodyOf(fetchMock, '/auth/reset-password')).toEqual({ token: 'tok-123', password: PASSWORD })
  })

  it('checks length and confirmation before calling the API', async () => {
    const fetchMock = stubApi({})
    renderApp('/reinitialisation/tok-123', { session: ANONYMOUS })

    await fill('court', 'autre')

    // The hint and the error carry the same sentence.
    expect(screen.getAllByText('Au moins 12 caractères.').length).toBeGreaterThan(1)
    expect(screen.getByText('Les deux mots de passe ne correspondent pas.')).toBeInTheDocument()
    expect(fetchMock.mock.calls.some(([url]) => url.endsWith('/auth/reset-password'))).toBe(false)
  })

  it('offers a new link when the token is invalid or expired', async () => {
    stubApi({
      'POST /api/auth/reset-password': [422, { detail: { code: 'token', message: 'expired' } }],
    })
    renderApp('/reinitialisation/dead', { session: ANONYMOUS })

    await fill()

    expect(await screen.findByRole('alert')).toHaveTextContent('Ce lien est invalide ou a expiré')
    expect(screen.getByRole('link', { name: 'Demander un nouveau lien' })).toHaveAttribute(
      'href',
      '/mot-de-passe-oublie',
    )
  })

  it('keeps the form when the server refuses the password', async () => {
    stubApi({
      'POST /api/auth/reset-password': [422, { detail: { code: 'password', message: 'weak' } }],
    })
    renderApp('/reinitialisation/tok-123', { session: ANONYMOUS })

    await fill()

    expect(await screen.findByRole('alert')).toHaveTextContent('au moins 12 caractères')
    expect(screen.getByRole('button', { name: 'Changer le mot de passe' })).toBeInTheDocument()
  })
})
