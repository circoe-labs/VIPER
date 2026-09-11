import { createContext, type ReactNode, useCallback, useContext, useState } from 'react'

import type { Company } from '../api/companies'
import { CompanyEditor } from './CompanyEditor'

export interface OpenCompanyEditorOptions {
  // Prefilled display name of a new company (e.g. the text typed in a Prospect editor picker, Task 15).
  initialName?: string
  onSaved?: (company: Company) => void
  onDeleted?: (id: string) => void
  // Once the editor is closed (saved or not).
  onClosed?: () => void
}

// `target`: a company id, or 'new'.
type OpenCompanyEditor = (target: string, options?: OpenCompanyEditorOptions) => void

const CompanyEditorContext = createContext<OpenCompanyEditor | null>(null)

interface Target extends OpenCompanyEditorOptions {
  companyId: string | null
  // A new session remounts the editor with a fresh draft.
  session: number
}

// One Company editor for the whole signed-in app (mounted by AppShell): any page — the companies list, the Prospect
// editor (Task 15), global search (Task 17) — opens it with `useCompanyEditor()('new' | id, options)`.
export function CompanyEditorProvider({ children }: { children: ReactNode }) {
  const [target, setTarget] = useState<Target | null>(null)
  const open = useCallback<OpenCompanyEditor>((company, options = {}) => {
    setTarget((current) => ({
      ...options,
      companyId: company === 'new' ? null : company,
      session: (current?.session ?? 0) + 1,
    }))
  }, [])
  return (
    <CompanyEditorContext.Provider value={open}>
      {children}
      {target && (
        <CompanyEditor
          key={target.session}
          companyId={target.companyId}
          initialName={target.initialName}
          onSaved={target.onSaved}
          onDeleted={target.onDeleted}
          onClose={() => {
            target.onClosed?.()
            setTarget(null)
          }}
          onOpenCompany={(id) => {
            open(id, { onSaved: target.onSaved, onDeleted: target.onDeleted, onClosed: target.onClosed })
          }}
        />
      )}
    </CompanyEditorContext.Provider>
  )
}

export function useCompanyEditor(): OpenCompanyEditor {
  const open = useContext(CompanyEditorContext)
  if (!open) throw new Error('useCompanyEditor must be used inside CompanyEditorProvider (AppShell).')
  return open
}
