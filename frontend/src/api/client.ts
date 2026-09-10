// Thin typed HTTP client. Every backend call goes through here; UI code never builds URLs itself.

export class ApiError extends Error {
  readonly status: number

  constructor(status: number, message: string) {
    super(message)
    this.name = 'ApiError'
    this.status = status
  }
}

export async function apiGet<T>(path: `/${string}`, signal?: AbortSignal): Promise<T> {
  const url = `/api${path}`
  const response = await fetch(url, { headers: { Accept: 'application/json' }, signal })
  if (!response.ok) {
    throw new ApiError(response.status, `GET ${url} failed with HTTP ${String(response.status)}`)
  }
  return (await response.json()) as T
}
