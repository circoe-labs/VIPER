import { type ReactNode, useEffect, useState } from 'react'
import { useNavigate } from 'react-router'

import { ApiError } from '../../api/client'
import { useReassessmentCommands } from '../../api/scoreReassessment'
import { useCompanyEditor } from '../../companies/CompanyEditorProvider'
import { prospectGraphHref } from '../prospectGraphLink'
import { ProspectContextMenuSurface, type SheetMenuActions } from './ProspectContactAction'
import './prospect-mission-menu.css'

interface Props {
  prospectId: string
  companyId: string | null
  disabledReason?: string | null
  // « Lier à… » / « Mission »: the sheet opens the Relations add flow / the Mission popover.
  onLink: () => void
  onMission: () => void
  // Leaving the sheet (graph): the editor asks first when changes are pending.
  guard: (go: () => void, label: string) => void
  children: ReactNode
}

const FEEDBACK_MS = 8000

// Wires the sheet's context menu to the real actions (reassessment command, graph route, Company editor) and says
// what happened: asking an agent is not instant, so the outcome (running / refused) is announced on screen.
export function ProspectSheetMenu({ prospectId, companyId, disabledReason, onLink, onMission, guard, children }: Props) {
  const navigate = useNavigate()
  const openCompany = useCompanyEditor()
  const { request } = useReassessmentCommands(prospectId)
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
      busy: request.isPending,
      run: () => {
        setFeedback({ tone: 'info', text: 'Réévaluation demandée…' })
        request.mutate(
          {},
          {
            onSuccess: () => {
              setFeedback({ tone: 'info', text: 'Réévaluation demandée : suivez-la sous « Score prospect ».' })
            },
            onError: (failure) => {
              setFeedback({
                tone: 'danger',
                text: failure instanceof ApiError ? failure.message : 'La réévaluation n’a pas pu être demandée. Réessayez.',
              })
            },
          },
        )
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
