import { useQueryClient } from '@tanstack/react-query'
import { useReducer, useRef } from 'react'
import { Link } from 'react-router'

import { type CommitResult, importKeys, previewImport } from '../api/imports'
import { ExportWorkbookButton } from '../exports/ExportWorkbookButton'
import { Button } from '../ui/Button'
import { AlertIcon, ArrowLeftIcon } from '../ui/icons'
import { PageHeader } from '../ui/PageHeader'
import { FileDrop } from './FileDrop'
import { ImportHistory } from './ImportHistory'
import { ImportResult } from './ImportResult'
import { flowReducer, INITIAL_FLOW, type Step } from './importFlow'
import { previewOptions, type ReviewDecisions } from './importPlan'
import { importErrorMessage } from './messages'
import { ReviewStep } from './ReviewStep'
import { SheetStep } from './SheetStep'
import './imports.css'

const STEPS: { step: Step; label: string }[] = [
  { step: 'idle', label: 'Fichier' },
  { step: 'sheet', label: 'Feuille' },
  { step: 'review', label: 'Vérification' },
  { step: 'done', label: 'Import' },
]

function stepIndex(step: Step): number {
  return step === 'analyzing' ? 0 : STEPS.findIndex((item) => item.step === step)
}

// Importer un fichier Excel (Task 09), a secondary page of Prospection (`/prospection/import`): analyse a workbook,
// confirm the sheet, resolve what the engine could not decide alone, then commit in one audited transaction. Nothing
// is written before the confirmation; the file never leaves the browser except to be analysed (ADR-0012).
export function ImportPage() {
  const [state, dispatch] = useReducer(flowReducer, INITIAL_FLOW)
  const queryClient = useQueryClient()
  // Only the latest analysis may update the page (a slower earlier one is ignored).
  const latest = useRef(0)
  const { step, file, preview } = state

  async function analyse(target: File, decisions: ReviewDecisions) {
    latest.current += 1
    const request = latest.current
    try {
      const result = await previewImport(target, previewOptions(decisions))
      if (request === latest.current) dispatch({ type: 'analyzed', preview: result })
    } catch (error) {
      if (request === latest.current) dispatch({ type: 'failed', message: importErrorMessage(error) })
    }
  }

  function choose(target: File) {
    dispatch({ type: 'choose', file: target })
    void analyse(target, INITIAL_FLOW.decisions)
  }

  // A new analysis of the same file with `decisions` (corrections, another sheet) or after a Settings change.
  function reanalyse(decisions: ReviewDecisions = state.decisions) {
    if (!file) return
    dispatch({ type: 'decide', update: () => decisions })
    dispatch({ type: 'reanalyze' })
    void analyse(file, decisions)
  }

  function committed(result: CommitResult) {
    dispatch({ type: 'committed', result })
    void queryClient.invalidateQueries({ queryKey: importKeys.history })
    void queryClient.invalidateQueries({ queryKey: ['companies'] })
    void queryClient.invalidateQueries({ queryKey: ['settings'] })
    void queryClient.invalidateQueries({ queryKey: ['explorer'] })
  }

  const current = stepIndex(step)
  return (
    <>
      <Link to="/prospection" className="import-page__back">
        <ArrowLeftIcon size={16} />
        Prospection
      </Link>
      <PageHeader
        title="Importer un fichier Excel"
        description="Analysez le fichier, vérifiez ce qui doit l’être puis confirmez : rien n’est enregistré avant votre confirmation, et tout import reste tracé."
        actions={
          <>
            {step !== 'idle' && step !== 'analyzing' && (
              <Button
                onClick={() => {
                  dispatch({ type: 'reset' })
                }}
              >
                Nouvel import
              </Button>
            )}
            <ExportWorkbookButton />
          </>
        }
      />
      <ol className="import-steps" aria-label="Étapes de l’import">
        {STEPS.map((item, index) => (
          <li
            key={item.step}
            className="import-steps__step"
            data-state={index < current ? 'done' : index === current ? 'current' : 'next'}
            aria-current={index === current ? 'step' : undefined}
          >
            <span className="import-steps__number">{index + 1}</span>
            {item.label}
          </li>
        ))}
      </ol>
      {state.error && (
        <p className="import-alert import-alert--danger" role="alert">
          <AlertIcon size={18} />
          {state.error}
        </p>
      )}
      {(step === 'idle' || step === 'analyzing') && (
        <FileDrop busy={step === 'analyzing'} fileName={file?.name ?? null} onFile={choose} />
      )}
      {step === 'sheet' && preview && (
        <SheetStep
          preview={preview}
          busy={state.reanalyzing}
          onConfirm={() => {
            dispatch({ type: 'confirmSheet' })
          }}
          onChooseSheet={(sheet) => {
            reanalyse({ ...state.decisions, sheet })
          }}
          onReset={() => {
            dispatch({ type: 'reset' })
          }}
        />
      )}
      {step === 'review' && preview && file && (
        <ReviewStep
          file={file}
          preview={preview}
          decisions={state.decisions}
          reanalyzing={state.reanalyzing}
          decide={(update) => {
            dispatch({ type: 'decide', update })
          }}
          onReanalyse={reanalyse}
          onCommitted={committed}
        />
      )}
      {step === 'done' && state.committed && (
        <ImportResult
          result={state.committed}
          onRestart={() => {
            dispatch({ type: 'reset' })
          }}
        />
      )}
      <ImportHistory />
    </>
  )
}
