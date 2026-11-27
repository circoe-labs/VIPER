import { useMutation, useQueryClient } from '@tanstack/react-query'

import { apiRequest, SAVE_TIMEOUT_MS } from './client'
import { refreshAfterWrite } from './refresh'

// An e-mail address that looks like someone else's (backend app/services/email_identity.py): it blocks generation,
// validation, scheduling and sending until the address is corrected or a person confirms it.
export type IdentityReason = 'colleague_name' | 'shared_address' | 'named_other'

export interface IdentityDoubt {
  address: string
  reason: IdentityReason
  // The other person the address points to (a colleague, another sheet holding it).
  other_name: string | null
  other_id: string | null
}

export function useConfirmIdentity(prospectId: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (address: string) =>
      apiRequest<undefined>('POST', `/prospects/${encodeURIComponent(prospectId)}/email-identity`, {
        body: { address },
        timeoutMs: SAVE_TIMEOUT_MS,
      }),
    onSuccess: () => refreshAfterWrite(queryClient, [['prospects'], ['prospection'], ['contact'], ['sequences']]),
  })
}
