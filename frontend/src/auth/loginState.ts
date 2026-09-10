import type { Path } from 'react-router'

import type { AnonymousReason } from './session'

// History state handed to /login: where to go back after sign-in and why the visitor was sent there. History state
// (unlike a `?next=` parameter) cannot be forged by a link, so it can never redirect outside the app.
export interface LoginState {
  reason: AnonymousReason
  from?: Pick<Path, 'pathname' | 'search' | 'hash'>
}

export function readLoginState(state: unknown): LoginState {
  return typeof state === 'object' && state !== null && 'reason' in state ? (state as LoginState) : { reason: 'initial' }
}
