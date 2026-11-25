import { useQueryClient } from '@tanstack/react-query'
import { useEffect, useReducer, useRef, useState } from 'react'
import { Link } from 'react-router'

import { analyzeImport, type CommitResult, importKeys, previewImport } from '../api/imports'
import { refreshAfterWrite } from '../api/refresh'
import { ExportWorkbookButton } from '../exports/ExportWorkbookButton'
import { Button } from '../ui/Button'
import { AlertIcon, ArrowLeftIcon, CheckIcon } from '../ui/icons'
import { PageHeader } from '../ui/PageHeader'
import { FileDrop } from './FileDrop'
import { ImportHistory } from './ImportHistory'
import { ImportResult } from './ImportResult'
import { flowReducer, INITIAL_FLOW, type Step } from './importFlow'
import { NO_DECISIONS, previewOptions, type ReviewDecisions } from './importPlan'
import { importErrorMessage } from './messages'
import { rememberFile } from './rememberedFile'
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
  // The import agent is reading the file (a minute or so).
  const [agentReading, setAgentReading] = useState(false)
  const { step, file, preview } = state

  // Each step starts at the top of the page (after the import, the long review would leave it at the bottom).
  useEffect(() => {
    window.scrollTo({ top: 0 })
  }, [step])

  async function analyse(target: File, decisions: ReviewDecisions) {
    latest.current += 1
    const request = latest.current
    setAgentReading(false)
    try {
      const result = await previewImport(target, previewOptions(decisions))
      if (request === latest.current) dispatch({ type: 'analyzed', preview: result })
    } catch (error) {
      if (request === latest.current) dispatch({ type: 'failed', message: importErrorMessage(error) })
    }
  }

  // A new file: the standard reading, then the agent's when columns are left unexplained. If the agent fails, the
  // standard reading stays, with the reason.
  async function open(target: File) {
    latest.current += 1
    const request = latest.current
    setAgentReading(false)
    try {
      const standard = await previewImport(target, previewOptions(NO_DECISIONS))
      if (request !== latest.current) return
      if (!standard.review.preview.summary.agent_recommended) {
        dispatch({ type: 'analyzed', preview: standard })
        return
      }
      setAgentReading(true)
      try {
        await readByAgent(target, request)
      } catch (error) {
        if (request !== latest.current) return
        dispatch({ type: 'analyzed', preview: standard })
        dispatch({ type: 'failed', message: importErrorMessage(error) })
      }
    } catch (error) {
      if (request === latest.current) dispatch({ type: 'failed', message: importErrorMessage(error) })
    }
  }

  // The review built on the agent's plan. Its rows differ from any earlier reading: decisions start over.
  async function readByAgent(target: File, request: number) {
    const { plan } = await analyzeImport(target)
    const decisions = { ...NO_DECISIONS, plan }
    const result = await previewImport(target, previewOptions(decisions))
    if (request !== latest.current) return
    dispatch({ type: 'decide', update: () => decisions })
    dispatch({ type: 'analyzed', preview: result })
  }

  // The running analysis is abandoned: its answer, when it comes, is ignored.
  function stopAnalysis() {
    latest.current += 1
    setAgentReading(false)
    dispatch({ type: 'reset' })
  }

  async function askAgent() {
    if (!file) return
    latest.current += 1
    const request = latest.current
    setAgentReading(true)
    dispatch({ type: 'reanalyze' })
    try {
      await readByAgent(file, request)
    } catch (error) {
      if (request === latest.current) dispatch({ type: 'failed', message: importErrorMessage(error) })
    }
  }

  function choose(target: File) {
    void rememberFile(target)
    dispatch({ type: 'choose', file: target })
    void open(target)
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
    void refreshAfterWrite(queryClient, [importKeys.history, ['companies'], ['settings'], ['explorer']])
  }

  const current = stepIndex(step)
  // The steps already passed can be reopened while nothing is written (not after the import): the sheet keeps the
  // review's decisions, the file choice starts over after a confirmation.
  function goBack(target: Step): (() => void) | undefined {
    if (step !== 'sheet' && step !== 'review') return undefined
    if (target === 'sheet' && step === 'review') {
      return () => {
        dispatch({ type: 'backToSheet' })
      }
    }
    if (target === 'idle') {
      return () => {
        if (step === 'sheet' || window.confirm('Revenir au choix du fichier ? Vos choix de vérification seront perdus.')) {
          dispatch({ type: 'reset' })
        }
      }
    }
    return undefined
  }
  const stepper = (
    <ol className="import-steps" aria-label="Étapes de l’import">
      {STEPS.map((item, index) => (
        <li
          key={item.step}
          className="import-steps__step"
          data-state={index < current ? 'done' : index === current ? 'current' : 'next'}
          aria-current={index === current ? 'step' : undefined}
        >
          {goBack(item.step) ? (
            <button type="button" className="import-steps__link" onClick={goBack(item.step)}>
              <span className="import-steps__number">{index < current ? <CheckIcon size={14} /> : index + 1}</span>
              {item.label}
            </button>
          ) : (
            <>
              <span className="import-steps__number">{index < current ? <CheckIcon size={14} /> : index + 1}</span>
              {item.label}
            </>
          )}
        </li>
      ))}
    </ol>
  )
  return (
    <>
      <Link to="/prospection" className="import-page__back">
        <ArrowLeftIcon size={16} />
        Prospection
      </Link>
      {step !== 'review' && (
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
      )}
      {step !== 'review' && stepper}
      {state.error && (
        <p className="import-alert import-alert--danger" role="alert">
          <AlertIcon size={18} />
          {state.error}
        </p>
      )}
      {(step === 'idle' || step === 'analyzing') && (
        <FileDrop busy={step === 'analyzing'} agent={agentReading} fileName={file?.name ?? null} onFile={choose} onCancel={stopAnalysis} />
      )}
      {step === 'sheet' && preview && (
        <SheetStep
          preview={preview}
          busy={state.reanalyzing}
          agentReading={state.reanalyzing && agentReading}
          onAskAgent={() => {
            void askAgent()
          }}
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
          stepper={stepper}
          onReset={() => {
            dispatch({ type: 'reset' })
          }}
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
