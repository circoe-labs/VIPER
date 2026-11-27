import { useMutation, useQueryClient } from '@tanstack/react-query'

import { apiRequest, SAVE_TIMEOUT_MS } from './client'
import { companyKeys } from './companies'
import { contactKeys } from './contact'
import { historyKeys } from './history'
import { homeKeys } from './home'
import { prospectKeys } from './prospects'
import { prospectionKeys } from './prospection'
import { refreshAfterWrite } from './refresh'
import { sequenceKeys } from './sequences'

// Who may be prospected (backend app/services/eligibility.py): the first block that applies, or null.
export type Block =
  | 'prospect_do_not_contact'
  | 'prospect_departed'
  | 'prospect_archived'
  | 'company_archived'
  | 'prospect_excluded'
  | 'company_excluded'

export type DepartureReason = 'retired' | 'left_company' | 'other'

export interface Hold {
  kind: 'archive' | 'exclusion'
  scope: 'prospect' | 'company'
  reason: string | null
  placed_at: string
  placed_by: string
}

export interface Lifecycle {
  block: Block | null
  departure_reason: DepartureReason | null
  holds: Hold[]
}

export type LifecycleAction = 'archive' | 'unarchive' | 'exclude' | 'reinstate' | 'depart' | 'return'

export interface LifecycleInput {
  action: LifecycleAction
  reason: string | null
  departure_reason?: DepartureReason
}

export interface LifecycleChanged {
  changed: boolean
  cancelled_messages: number
  in_flight_messages: number
  lifecycle: Lifecycle
}

export interface LifecycleSubject {
  type: 'prospect' | 'company'
  id: string
  name: string
}

// One explicit action on a prospect or a company; every list, counter and sheet that depends on eligibility is read
// again.
export function useLifecycleChange(subject: LifecycleSubject) {
  const queryClient = useQueryClient()
  const path = subject.type === 'prospect' ? 'prospects' : 'companies'
  return useMutation({
    mutationFn: (input: LifecycleInput) =>
      apiRequest<LifecycleChanged>('POST', `/${path}/${encodeURIComponent(subject.id)}/lifecycle`, { body: input, timeoutMs: SAVE_TIMEOUT_MS }),
    onSuccess: () => {
      void refreshAfterWrite(queryClient, [
        prospectionKeys.all,
        companyKeys.all,
        contactKeys.all,
        homeKeys.all,
        historyKeys.subject(path, subject.id),
        ...(subject.type === 'prospect' ? [prospectKeys.detail(subject.id), sequenceKeys.prospect(subject.id)] : [['prospects'], sequenceKeys.all]),
        ['warehouses'],
      ])
    },
  })
}
