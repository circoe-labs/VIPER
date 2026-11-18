import { type ReactNode, useEffect, useState } from 'react'
import { useNavigate } from 'react-router'

import { evaluationFailure, useEvaluateScore } from '../../api/scoreEvaluation'
import { useCompanyEditor } from '../../companies/CompanyEditorProvider'
import { prospectGraphHref } from '../prospectGraphHref'
import { ProspectContextMenuSurface, type SheetMenuActions } from './ProspectContactAction'
import './prospect-mission-menu.css'

interface ActionsParams {
  prospectId: string
  companyId: string | null
  // « Lier à… » / « Mission »: the sheet opens the Relations add flow / the Mission popover.
  onLink: () => void
  onMission: () => void
  // Leaving the sheet (graph): the editor asks first when changes are pending.
  guard: (go: () => void, label: string) => void
}

interface Props {
  prospectId: string
  disabledReason?: string | null
  // From `useSheetMenu`: the one set of actions shared by the right-click menu and the header's « … » menu.
  menu: SheetMenu
  children: ReactNode
}

export interface SheetMenu {
  actions: SheetMenuActions
  feedback: { tone: 'info' | 'danger'; text: string } | null
}

const FEEDBACK_MS = 8000

// The sheet's actions wired to the real operations (score evaluation, graph route, Company editor) — one instance
// per sheet, read by the right-click menu (ProspectSheetMenu) and the header's « … » menu. It also says what happened:
// the AI takes a few seconds, so the outcome (running / done / refused) is announced on screen.
export function useSheetMenu({ prospectId, companyId, onLink, onMission, guard }: ActionsParams): SheetMenu {
  const navigate = useNavigate()
  const openCompany = useCompanyEditor()
  const evaluate = useEvaluateScore(prospectId)
  const [feedback, setFeedback] = useState<{ tone: 'info' | 'danger'; text: string } | null>(null)

  useEffect(() => {
    if (!feedback) return
    const timer = window.setTimeout(() => {
      setFeedback(null)
    }, FEEDBACK_MS)
    return () => {
      window.clearTimeout(timer)
    }
  }, [feedback])

  const actions: SheetMenuActions = {
    link: onLink,
    mission: onMission,
    reassess: {
      busy: evaluate.isPending,
      run: () => {
        setFeedback({ tone: 'info', text: 'Évaluation du score en cours…' })
        evaluate.start(undefined, {
          onSuccess: (score) => {
            setFeedback({ tone: 'info', text: `Score mis à jour : ${String(score.total)} sur 100.` })
          },
          onError: (failure) => {
            setFeedback({ tone: 'danger', text: `Évaluation échouée, score inchangé : ${evaluationFailure(failure)}` })
          },
        })
      },
    },
    graph: () => {
      guard(() => void navigate(prospectGraphHref(prospectId)), 'Ouvrir le graphe sans enregistrer')
    },
    company: {
      open: () => {
        if (companyId) openCompany(companyId)
      },
      disabledReason: companyId ? null : 'Aucune entreprise choisie pour ce prospect.',
    },
  }

  return { actions, feedback }
}

// Wraps the sheet: right click, the context-menu key or Shift+F10 offer the sheet's actions.
export function ProspectSheetMenu({ prospectId, disabledReason, menu, children }: Props) {
  const { actions, feedback } = menu
  return (
    <ProspectContextMenuSurface prospectId={prospectId} disabledReason={disabledReason} actions={actions}>
      {children}
      {feedback && (
        <p className="sheet-menu-feedback" data-tone={feedback.tone} role={feedback.tone === 'danger' ? 'alert' : 'status'}>
          {feedback.text}
        </p>
      )}
    </ProspectContextMenuSurface>
  )
}
