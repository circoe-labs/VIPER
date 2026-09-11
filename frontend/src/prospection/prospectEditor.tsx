import { type ComponentType, createContext, useContext } from 'react'

import { ProspectEditor } from '../prospects/ProspectEditor'
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
// The default implementation is the Prospect editor drawer (prospects/ProspectEditor.tsx); a test can provide another
// one with `<ProspectEditorContext.Provider value={{ canCreate, Editor }}>`.

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

export const ProspectEditorContext = createContext<ProspectEditorImplementation>({ canCreate: true, Editor: ProspectEditor })

export function useProspectEditor(): ProspectEditorImplementation {
  return useContext(ProspectEditorContext)
}
