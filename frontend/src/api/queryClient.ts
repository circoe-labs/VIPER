import { QueryClient } from '@tanstack/react-query'

import { RequestTimeoutError } from './client'

const RETRIES = 3

// The application's cache. A read that passed its deadline is not repeated on its own (three more silent waits would
// keep the screen loading for minutes): the screen says so and offers « Réessayer ». `networkMode: 'always'`: a browser
// believing itself offline must fail visibly, not hold requests (and their spinners) until it changes its mind.
export function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        networkMode: 'always',
        retry: (failures, error) => failures < RETRIES && !(error instanceof RequestTimeoutError),
      },
      mutations: { networkMode: 'always' },
    },
  })
}
