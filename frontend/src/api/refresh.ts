import type { QueryClient, QueryKey } from '@tanstack/react-query'

// After a write: every cached answer under `keys` is read again by a request sent after the write. Invalidation alone
// is not enough — TanStack Query cancels a request in flight only when its query already holds data; the first request
// of a new key (a search typed just before the save) is kept, and its answer, read before the write, would become the
// current one. Cancelling first drops such requests (the queries go back to their previous state), then the active
// queries refetch and the others are marked stale.
export async function refreshAfterWrite(queryClient: QueryClient, keys: readonly QueryKey[]): Promise<void> {
  await Promise.all(keys.map((queryKey) => queryClient.cancelQueries({ queryKey })))
  await Promise.all(keys.map((queryKey) => queryClient.invalidateQueries({ queryKey })))
}
