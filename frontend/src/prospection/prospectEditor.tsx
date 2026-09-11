import { type ComponentType, createContext, useContext, useEffect } from 'react'
import { useNavigate } from 'react-router'

import { recordHref } from '../database/explorerView'
import type { ProspectQueue } from './queue'

// Open-editor contract between the Prospection list (Task 14) and the Prospect editor (Task 15).
//
// - Opening a prospect sets `?prospect=<id>` on the list's URL (pushed: browser Back closes the editor); « Ajouter un
//   prospect » sets `?prospect=new`. The list renders `Editor` while the parameter is set, keeping every other URL
//   parameter (segment, search, filters, sort, page) so the list stays in context behind it.
// - `queue` is the list order when the editor opened, for « Enregistrer et suivant »: `await queue.next(id)` gives the
//   next prospect (and its page) even after a save removed the current one from the segment; pass it to `onNavigate`.
// - `onNavigate(id, { page })` replaces the open prospect (Save & Next); `onNavigate(null)` closes the editor.
// - After a write, invalidate `prospectionKeys.all` (api/prospection.ts) so counters and pages refresh.
//
// Task 15 provides its drawer with `<ProspectEditorContext.Provider value={{ canCreate: true, Editor }}>` (e.g. in
// AppShell, next to CompanyEditorProvider). Until then the default below is an honest fallback: it opens the person's
// row in the Database Explorer, and « Ajouter un prospect » stays disabled.

export interface ProspectEditorProps {
  // A prospect id, or 'new'.
  target: string
  queue: ProspectQueue
  onNavigate: (target: string | null, options?: { page?: number }) => void
}

export interface ProspectEditorImplementation {
  // Whether « Ajouter un prospect » can open the editor on a new person.
  canCreate: boolean
  Editor: ComponentType<ProspectEditorProps>
}

// The prospect's row in the Database Explorer (`prospects` filtered on its id).
export function prospectRecordHref(id: string): string {
  return recordHref('prospects', id)
}

// Replaces the `?prospect=` history entry by the explorer, so Back returns to the list as it was.
function ExplorerFallback({ target, onNavigate }: ProspectEditorProps) {
  const navigate = useNavigate()
  useEffect(() => {
    if (target === 'new') onNavigate(null)
    else void navigate(prospectRecordHref(target), { replace: true })
  }, [target, navigate, onNavigate])
  return null
}

export const EXPLORER_FALLBACK: ProspectEditorImplementation = { canCreate: false, Editor: ExplorerFallback }

export const ProspectEditorContext = createContext<ProspectEditorImplementation>(EXPLORER_FALLBACK)

export function useProspectEditor(): ProspectEditorImplementation {
  return useContext(ProspectEditorContext)
}
