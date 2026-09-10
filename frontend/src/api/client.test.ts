import { describe, expect, it } from 'vitest'

import { stubFetchJson } from '../test/render'
import { ApiError, apiGet } from './client'

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
    expect(error).toMatchObject({ status: 503 })
  })
})
