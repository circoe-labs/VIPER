import { createContext } from 'react'

import type { LifecycleSubject } from '../api/lifecycle'

export interface LifecycleRequest {
  subject: LifecycleSubject
  intent: 'status' | 'archive'
  onChanged?: () => void
}

// Opens the lifecycle dialog above the page. The dialog must outlive what asked for it: a row leaves its list as soon
// as the change is saved, and the dialog still has to say what happened.
export const LifecycleHostContext = createContext<((request: LifecycleRequest) => void) | null>(null)
