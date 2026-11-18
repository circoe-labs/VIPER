import { useEffect, useState } from 'react'

import type { ProspectScore } from '../api/prospects'
import { evaluationFailure, useEvaluateScore, useEvaluationState } from '../api/scoreEvaluation'
import { useElapsed } from '../lib/useElapsed'
import { Button } from '../ui/Button'
import { AlertIcon, CheckCircleIcon, ChevronRightIcon, SparklesIcon } from '../ui/icons'
import { ScoreRing } from '../ui/ScoreRing'
import { BAND_LABELS, BAND_TONES } from './scoreView'
import './score-evaluation.css'

// How long « Score mis à jour » stays after an evaluation, before the card goes back to its resting state.
export const SUCCESS_VISIBLE_MS = 8000

type Phase = 'idle' | 'unevaluated' | 'running' | 'success' | 'failed'
type Outcome = 'success' | 'error' | null

interface ScoreEvaluationProps {
  // Null = the prospect is not saved yet: the card only shows its score, without any evaluation action.
  prospectId: string | null
  score: ProspectScore
  // « Voir le détail » opens the detail dialog (owned by ProspectScoreCard).
  onOpenDetail: () => void
}

// An evaluated score: an AI assessment, or notes that carry points.
export function isEvaluated(score: ProspectScore): boolean {
  return Boolean(score.assessment) || score.contributions.length > 0
}

// Body of the « Score prospect » card. « Évaluer / Réévaluer le score » asks the AI directly (seconds, no agent): its states
// REPLACE this body in place, at the same height (prospect-score.css gives it a fixed block size): idle, not evaluated,
// in progress (animated ring and a live counter), success (the ring eases to the new value), failure (one line, « Réessayer »).
// Nothing is ever added below or around it, so the layout never moves. A failure never touches the current score.
export function ScoreEvaluation({ prospectId, score, onOpenDetail }: ScoreEvaluationProps) {
  const evaluation = useEvaluationState(prospectId)
  const evaluate = useEvaluateScore(prospectId ?? '')
  const running = evaluation.status === 'pending'
  const seconds = useElapsed(running ? evaluation.startedAt : null)
  const evaluated = isEvaluated(score)

  // What this card watched finish (a request started elsewhere, e.g. the Mission menu, counts too). Derived while rendering:
  // the status changes, so does the outcome; an old result found on mount is not announced again.
  // Keyed by the request's send time, so a result that lands without a render in `pending` is not missed.
  const [handled, setHandled] = useState(evaluation.startedAt)
  const [outcome, setOutcome] = useState<Outcome>(null)
  if (evaluation.status === 'pending') {
    if (outcome !== null) setOutcome(null)
  } else if (evaluation.startedAt !== handled && (evaluation.status === 'success' || evaluation.status === 'error')) {
    setHandled(evaluation.startedAt)
    setOutcome(evaluation.status)
  }
  useEffect(() => {
    if (outcome !== 'success') return undefined
    const timer = setTimeout(() => {
      setOutcome(null)
    }, SUCCESS_VISIBLE_MS)
    return () => {
      clearTimeout(timer)
    }
  }, [outcome])

  const phase: Phase = running ? 'running' : outcome === 'error' ? 'failed' : outcome === 'success' ? 'success' : evaluated ? 'idle' : 'unevaluated'
  const failure = evaluationFailure(evaluation.error)

  function ask() {
    setOutcome(null)
    evaluate.start(score)
  }

  return (
    <div className="prospect-score score-state" data-phase={phase} data-band={score.band} role="group" aria-label={groupName(score, evaluated, phase)}>
      <Visual phase={phase} score={score} evaluated={evaluated} from={evaluation.previous?.total ?? score.total} />
      <div className="score-state__text">
        <Text phase={phase} score={score} seconds={seconds} failure={failure} />
        <Actions phase={phase} evaluated={evaluated} canAsk={prospectId !== null} onAsk={ask} onOpenDetail={onOpenDetail} />
      </div>
      <p className="visually-hidden" role="status" aria-live="polite">
        {announcement(phase, score, failure)}
      </p>
    </div>
  )
}

function groupName(score: ProspectScore, evaluated: boolean, phase: Phase): string {
  if (phase === 'running') return 'Score prospect : évaluation en cours'
  if (!evaluated) return 'Score prospect : non évalué'
  return `Score prospect : ${String(score.total)} sur 100, niveau ${BAND_LABELS[score.band].toLowerCase()}`
}

function announcement(phase: Phase, score: ProspectScore, failure: string): string {
  switch (phase) {
    case 'running':
      return 'Évaluation en cours : l’IA analyse la fiche.'
    case 'success':
      return `Score mis à jour : ${String(score.total)} sur 100. ${score.summary}`
    case 'failed':
      return `L’évaluation a échoué. ${failure} Le score actuel reste valable.`
    default:
      return ''
  }
}

// --- left: the ring ----------------------------------------------------------------------------------------------

interface VisualProps {
  phase: Phase
  score: ProspectScore
  evaluated: boolean
  // The score before the request: the ring eases from it to the new one.
  from: number
}

function Visual({ phase, score, evaluated, from }: VisualProps) {
  if (phase === 'running') return <ProgressRing />
  if (!evaluated) {
    return (
      <span className="prospect-score__placeholder" aria-hidden="true">
        –
      </span>
    )
  }
  if (phase === 'success') return <EasedRing from={from} score={score} />
  return (
    <span className="score-state__ring">
      <ScoreRing value={score.total} tone={BAND_TONES[score.band]} />
    </span>
  )
}

// The arc starts at the previous value and, one frame later, moves to the new one (the CSS transition does the easing;
// it stops under prefers-reduced-motion).
function EasedRing({ from, score }: { from: number; score: ProspectScore }) {
  const [shown, setShown] = useState(Math.max(1, from))
  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      setShown(score.total)
    })
    return () => {
      cancelAnimationFrame(frame)
    }
  }, [score.total])
  return (
    <span className="score-state__ring" data-just-updated>
      <ScoreRing value={shown} tone={BAND_TONES[score.band]} />
    </span>
  )
}

// Same footprint as ScoreRing. Dashed segments turn slowly while the AI works; three dots sit inside. Both are decorative
// (the state is written next to it, with its counter).
function ProgressRing() {
  return (
    <span className="score-progress" aria-hidden="true">
      <svg className="score-progress__svg" viewBox="0 0 100 100" focusable="false">
        <circle className="score-progress__track" cx="50" cy="50" r="44" />
        <circle className="score-progress__dashes" cx="50" cy="50" r="44" pathLength={100} />
      </svg>
      <span className="score-progress__dots">
        <i />
        <i />
        <i />
      </span>
    </span>
  )
}

// --- right: three lines (title, detail, actions), always ----------------------------------------------------------

interface TextProps {
  phase: Phase
  score: ProspectScore
  seconds: number
  failure: string
}

function Text({ phase, score, seconds, failure }: TextProps) {
  switch (phase) {
    case 'running':
      return (
        <>
          <p className="score-state__title">
            <span className="score-badge" data-tone="success">
              <SparklesIcon size={13} />
              Évaluation en cours
            </span>
          </p>
          <p className="score-state__detail" title="L’IA répond en quelques secondes ; la demande est abandonnée au bout de 2 minutes.">
            L’IA analyse la fiche… · <span className="score-state__timer">{formatElapsed(seconds)}</span>
          </p>
        </>
      )
    case 'success':
      return (
        <>
          <p className="score-state__title" data-tone="success">
            <CheckCircleIcon size={14} />
            Score mis à jour
          </p>
          <p className="score-state__detail" title={score.summary}>
            {score.summary}
          </p>
        </>
      )
    case 'failed':
      return (
        <>
          <p className="score-state__title" data-tone="danger">
            <AlertIcon size={14} />
            Échec · score inchangé
          </p>
          <p className="score-state__detail" title={failure}>
            {failure}
          </p>
        </>
      )
    case 'unevaluated':
      return (
        <>
          <p className="score-state__title" data-tone="muted">
            Non évalué
          </p>
          <p className="score-state__detail">Aucune évaluation pour l’instant.</p>
        </>
      )
    default:
      return (
        <>
          <p className="score-state__title" data-tone="band">
            {BAND_LABELS[score.band]}
          </p>
          <p className="score-state__detail" title={score.summary}>
            {score.summary}
          </p>
        </>
      )
  }
}

interface ActionsProps {
  phase: Phase
  evaluated: boolean
  canAsk: boolean
  onAsk: () => void
  onOpenDetail: () => void
}

function Actions({ phase, evaluated, canAsk, onAsk, onOpenDetail }: ActionsProps) {
  const detail = (
    <button type="button" className="prospect-score__more" aria-haspopup="dialog" onClick={onOpenDetail}>
      Voir le détail
      <ChevronRightIcon size={14} />
    </button>
  )
  switch (phase) {
    case 'running':
      return <div className="score-state__actions" />
    case 'failed':
      return (
        <div className="score-state__actions">
          <Button size="sm" variant="secondary" icon={SparklesIcon} disabled={!canAsk} onClick={onAsk}>
            Réessayer
          </Button>
        </div>
      )
    case 'success':
      return <div className="score-state__actions">{detail}</div>
    case 'unevaluated':
      return (
        <div className="score-state__actions">
          {canAsk && (
            <Button size="sm" variant="secondary" icon={SparklesIcon} onClick={onAsk}>
              Évaluer
            </Button>
          )}
        </div>
      )
    default:
      return (
        <div className="score-state__actions">
          {detail}
          {canAsk && (
            <Button
              size="sm"
              variant="ghost"
              icon={SparklesIcon}
              aria-label="Réévaluer le score"
              title="L’IA relit la fiche et recalcule le score (adéquation commerciale uniquement)."
              onClick={onAsk}
            >
              {evaluated ? 'Réévaluer' : 'Évaluer'}
            </Button>
          )}
        </div>
      )
  }
}

export function formatElapsed(seconds: number): string {
  const minutes = Math.floor(seconds / 60)
  const rest = seconds % 60
  return minutes > 0 ? `${String(minutes)} min ${String(rest).padStart(2, '0')} s` : `${String(rest)} s`
}
