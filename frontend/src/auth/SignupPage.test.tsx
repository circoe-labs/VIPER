import { screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'

import { renderApp, stubApi } from '../test/render'
import type { SessionState } from './session'

const ANONYMOUS: SessionState = { status: 'anonymous', reason: 'initial' }
const PASSWORD = 'un mot de passe assez long'

async function fill(password = PASSWORD, confirm = PASSWORD) {
  await userEvent.type(screen.getByRole('textbox', { name: 'Nom complet' }), 'Nouveau Venu')
  await userEvent.type(screen.getByRole('textbox', { name: /Adresse e-mail/ }), 'nouveau@circoe.com')
  await userEvent.type(screen.getByLabelText(/^Mot de passe/), password)
  await userEvent.type(screen.getByLabelText('Confirmer le mot de passe'), confirm)
  await userEvent.click(screen.getByRole('button', { name: 'Demander un compte' }))
}

describe('SignupPage', () => {
  it('is reached from the sign-in page', async () => {
    stubApi({})
    renderApp('/login', { session: ANONYMOUS })

    await userEvent.click(screen.getByRole('link', { name: 'Créer un compte' }))

    expect(screen.getByRole('heading', { level: 1, name: 'Créer un compte' })).toBeInTheDocument()
  })

  it('sends the request and says the admin must confirm it', async () => {
    const fetchMock = stubApi({ 'POST /api/auth/signup': [202, { status: 'pending' }] })
    renderApp('/inscription', { session: ANONYMOUS })

    await fill()

    expect(await screen.findByText(/Demande envoyée/)).toBeInTheDocument()
    const [, init] = fetchMock.mock.calls.find(([url]) => url.endsWith('/auth/signup')) ?? []
    expect(JSON.parse(init?.body as string)).toEqual({
      email: 'nouveau@circoe.com',
      display_name: 'Nouveau Venu',
      password: PASSWORD,
    })
  })

  it('checks the confirmation before calling the API', async () => {
    const fetchMock = stubApi({})
    renderApp('/inscription', { session: ANONYMOUS })

    await fill(PASSWORD, 'autre chose encore')

    expect(screen.getByText('Les deux mots de passe ne correspondent pas.')).toBeInTheDocument()
    expect(fetchMock.mock.calls.some(([url]) => url.endsWith('/auth/signup'))).toBe(false)
  })

  it('explains a refused domain', async () => {
    stubApi({
      'POST /api/auth/signup': [422, { detail: { code: 'domain', message: 'Only CIRCOE addresses' } }],
    })
    renderApp('/inscription', { session: ANONYMOUS })

    await fill()

    expect(await screen.findByText('Adresse e-mail non autorisée.')).toBeInTheDocument()
  })
})
