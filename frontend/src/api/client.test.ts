import { describe, expect, it, vi } from 'vitest'

import { stubFetchJson } from '../test/render'
import { ApiError, apiGet, apiRequest, onUnauthorized, setCsrfToken } from './client'

describe('apiGet', () => {
  it('prefixes the path with /api and returns the parsed JSON body', async () => {
    const fetchMock = stubFetchJson(200, { status: 'ok', database: 'ok' })

    await expect(apiGet('/health')).resolves.toEqual({ status: 'ok', database: 'ok' })
    expect(fetchMock).toHaveBeenCalledWith('/api/health', expect.objectContaining({
      headers: { Accept: 'application/json' },
    }))
  })

  it('throws an ApiError carrying the HTTP status on failure', async () => {
    stubFetchJson(503, { status: 'degraded', database: 'unavailable' })

    const error: unknown = await apiGet('/health').catch((caught: unknown) => caught)

    expect(error).toBeInstanceOf(ApiError)
    expect(error).toMatchObject({ status: 503, detail: undefined })
  })

  it('keeps the detail of a JSON error body', async () => {
    stubFetchJson(422, { detail: { message: 'Refusé', errors: [] } })

    await expect(apiGet('/things')).rejects.toMatchObject({ status: 422, detail: { message: 'Refusé', errors: [] } })
  })

  it('never sends the CSRF header on reads', async () => {
    setCsrfToken('jeton')
    const fetchMock = stubFetchJson(200, {})

    await apiGet('/health')

    expect(fetchMock).toHaveBeenCalledWith('/api/health', expect.objectContaining({
      method: 'GET',
      headers: { Accept: 'application/json' },
    }))
  })
})

describe('apiRequest', () => {
  it.each(['POST', 'PUT', 'PATCH', 'DELETE'] as const)('sends the CSRF token and a JSON body on %s', async (method) => {
    setCsrfToken('jeton')
    const fetchMock = stubFetchJson(200, { saved: true })

    await expect(apiRequest(method, '/things', { body: { label: 'Test' } })).resolves.toEqual({ saved: true })

    expect(fetchMock).toHaveBeenCalledWith('/api/things', expect.objectContaining({
      method,
      body: '{"label":"Test"}',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'X-CSRF-Token': 'jeton' },
    }))
  })

  it('resolves to undefined on 204 No Content', async () => {
    stubFetchJson(204, null)

    await expect(apiRequest('POST', '/auth/logout')).resolves.toBeUndefined()
  })

  it('notifies listeners when an authenticated call answers 401', async () => {
    const listener = vi.fn()
    const unsubscribe = onUnauthorized(listener)
    stubFetchJson(401, { detail: 'Not authenticated.' })

    await expect(apiRequest('GET', '/things')).rejects.toMatchObject({ status: 401 })
    await expect(apiRequest('POST', '/auth/login', { anonymous: true })).rejects.toMatchObject({ status: 401 })
    unsubscribe()
    await expect(apiRequest('GET', '/things')).rejects.toMatchObject({ status: 401 })

    expect(listener).toHaveBeenCalledTimes(1)
  })
})
