import { screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { OAuthRequest } from '../api/oauth'
import { SHELL_API } from '../test/homeApi'
import { renderApp, stubApi } from '../test/render'

const REQUEST: OAuthRequest = {
  id: '00000000-0000-7000-b000-000000000001',
  client_name: 'ChatGPT',
  redirect_host: 'chatgpt.com',
  expires_at: '2026-11-03T10:10:00+00:00',
}
const PATH = `/api/oauth/requests/${REQUEST.id}`

describe('OAuthConsentPage', () => {
  const assign = vi.fn()
  afterEach(() => {
    vi.unstubAllGlobals()
    assign.mockReset()
  })

  function stubLocation() {
    vi.stubGlobal('location', { assign, origin: window.location.origin, href: window.location.href })
  }

  it('asks the person and sends the code back to the connector on « Autoriser »', async () => {
    const fetchMock = stubApi({
      ...SHELL_API,
      [`GET ${PATH}`]: [200, REQUEST],
      [`POST ${PATH}/approve`]: [200, { redirect: 'https://chatgpt.com/cb?code=abc&state=s' }],
    })
    renderApp(`/autoriser?demande=${REQUEST.id}`)
    stubLocation()

    expect(await screen.findByRole('heading', { name: 'Autoriser « ChatGPT » à accéder à VIPER ?' })).toBeInTheDocument()
    expect(screen.getByText('chatgpt.com')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Autoriser' }))

    await vi.waitFor(() => {
      expect(assign).toHaveBeenCalledWith('https://chatgpt.com/cb?code=abc&state=s')
    })
    expect(fetchMock.mock.calls.filter(([url]) => url.endsWith('/approve'))).toHaveLength(1)
  })

  it('sends a refusal back on « Refuser »', async () => {
    stubApi({
      ...SHELL_API,
      [`GET ${PATH}`]: [200, REQUEST],
      [`POST ${PATH}/deny`]: [200, { redirect: 'https://chatgpt.com/cb?error=access_denied' }],
    })
    renderApp(`/autoriser?demande=${REQUEST.id}`)
    stubLocation()

    await userEvent.click(await screen.findByRole('button', { name: 'Refuser' }))

    await vi.waitFor(() => {
      expect(assign).toHaveBeenCalledWith('https://chatgpt.com/cb?error=access_denied')
    })
  })

  it('says when the request expired', async () => {
    stubApi({ ...SHELL_API, [`GET ${PATH}`]: [404, { detail: { code: 'oauth_request_unavailable' } }] })

    renderApp(`/autoriser?demande=${REQUEST.id}`)

    expect(await screen.findByRole('heading', { name: 'Demande expirée' })).toBeInTheDocument()
  })

  it('shows a refusal the server would not send to an unknown address', async () => {
    stubApi({ ...SHELL_API })

    renderApp('/autoriser?erreur=This%20redirect_uri%20is%20not%20registered.')

    expect(await screen.findByRole('heading', { name: 'Connexion refusée' })).toBeInTheDocument()
    expect(screen.getByText(/This redirect_uri is not registered/)).toBeInTheDocument()
  })
})
