import type { EditableSection } from './profileEditing'
import type { ProspectDraft } from './prospectForm'

// The Prospect editor's unsaved input, kept across a reload of the tab (a frozen or restarted application loses
// nothing). sessionStorage: this tab only, gone when it closes — personal data is not left on the machine. Dropped once
// saved, reverted or explicitly abandoned, and at sign-out (auth/session.ts); kept when the session merely expires.

const PREFIX = 'viper.prospect-draft.v1.'

export interface KeptDraft {
  // The prospect version the input was typed on; null for a new prospect.
  version: string | null
  draft: ProspectDraft
  editing: EditableSection[]
}

// Storage can be unavailable or full: the editor then works as before, and the console says the input is not kept.
function attempt<T>(action: string, run: () => T): T | null {
  try {
    return run()
  } catch (error) {
    console.warn(`Prospect draft: ${action} failed`, error instanceof Error ? error.name : typeof error)
    return null
  }
}

export function keepDraft(target: string, kept: KeptDraft): void {
  attempt('write', () => {
    window.sessionStorage.setItem(PREFIX + target, JSON.stringify(kept))
  })
}

export function keptDraft(target: string): KeptDraft | null {
  return attempt('read', () => {
    const raw = window.sessionStorage.getItem(PREFIX + target)
    if (raw === null) return null
    const value = JSON.parse(raw) as Partial<KeptDraft> | null
    const draft = value?.draft
    // Written by another build of the form: ignored rather than shown half-filled.
    return draft && Array.isArray(draft.emails) && Array.isArray(draft.phones) && Array.isArray(value.editing)
      ? (value as KeptDraft)
      : null
  })
}

export function forgetDraft(target: string): void {
  attempt('removal', () => {
    window.sessionStorage.removeItem(PREFIX + target)
  })
}

export function forgetAllDrafts(): void {
  attempt('removal', () => {
    for (const key of Object.keys(window.sessionStorage)) {
      if (key.startsWith(PREFIX)) window.sessionStorage.removeItem(key)
    }
  })
}
