import { useQueryClient } from '@tanstack/react-query'
import { useEffect, useState } from 'react'

import { ReviewDialog } from '../agents/ReviewDialog'
import { ApiError } from '../api/client'
import type { ProspectScore } from '../api/prospects'
import {
  type Reassessment,
  reassessmentKeys,
  refreshScore,
  useReassessmentCommands,
  useScoreReassessment,
  WAITING_STATUSES,
} from '../api/scoreReassessment'
import { Button } from '../ui/Button'
import { AlertIcon, CheckCircleIcon, ChevronRightIcon, SparklesIcon } from '../ui/icons'
import { ScoreRing } from '../ui/ScoreRing'
import { BAND_LABELS, BAND_TONES } from './scoreView'
import './score-reassessment.css'

// VIPER launches no agent: external MCP agents poll the queue. A request nobody picks up must therefore not wait
// silently for ever: past these deadlines the card says how long it waited and what that probably means.
export const QUEUE_TIMEOUT_SECONDS = 3 * 60
export const RUN_TIMEOUT_SECONDS = 10 * 60
// How long « Score mis à jour » stays after a proposal was applied.
const APPLIED_VISIBLE_MS = 6000

type Phase = 'idle' | 'unevaluated' | 'waiting' | 'running' | 'stalled' | 'proposal' | 'failed' | 'applied'

interface ScoreReassessmentProps {
  // Null = the prospect is not saved yet: the card only shows its score, without any reassessment action.
  prospectId: string | null
  score: ProspectScore
  // « Voir le détail » opens the detail dialog (owned by ProspectScoreCard).
  onOpenDetail: () => void
  // The score changed (a proposal was applied): the editor may refresh what it derives from it.
  onScoreChanged?: () => void
}

// Body of the « Score prospect » card. Every state of « Réévaluer le score » (S4) REPLACES this body in place, at the
// same height (prospect-score.css gives it a fixed block size): idle, not evaluated, waiting for an agent, analysis
// in progress, proposal ready, failure, applied. Nothing is ever added below or around it, so the layout never moves.
// The agent only proposes; the person reads the proposal in the ordinary result review and applies it, the only way
// the score moves. A failure, a timeout or a cancellation never touches the current score.
export function ScoreReassessment({ prospectId, score, onOpenDetail, onScoreChanged }: ScoreReassessmentProps) {
  const queryClient = useQueryClient()
  const state = useScoreReassessment(prospectId)
  const { request, cancel } = useReassessmentCommands(prospectId ?? '')
  const [reviewing, setReviewing] = useState<string | null>(null)
  const [appliedBy, setAppliedBy] = useState<string | null | undefined>(undefined)

  const current = state.data
  const waiting = current !== undefined && WAITING_STATUSES.includes(current.status)
  const seconds = useElapsedSeconds(waiting ? current.requested_at : null)
  const evaluated = score.contributions.length > 0
  const commandFailure = request.error ?? cancel.error

  useEffect(() => {
    if (appliedBy === undefined) return undefined
    const timer = setTimeout(() => {
      setAppliedBy(undefined)
    }, APPLIED_VISIBLE_MS)
    return () => {
      clearTimeout(timer)
    }
  }, [appliedBy])

  function ask() {
    setAppliedBy(undefined)
    cancel.reset()
    request.mutate({})
  }

  async function reviewClosed() {
    setReviewing(null)
    await refreshScore(queryClient, prospectId ?? '')
    const next = queryClient.getQueryData<Reassessment>(reassessmentKeys.detail(prospectId ?? ''))
    if (next?.status === 'applied') {
      setAppliedBy(next.decided_by)
      onScoreChanged?.()
    }
  }

  const phase = phaseOf({ current, commandFailed: Boolean(commandFailure), sending: request.isPending, evaluated, appliedNow: appliedBy !== undefined, seconds })
  const failure = failureText(commandFailure, current)

  return (
    <div className="prospect-score score-state" data-phase={phase} data-band={score.band} role="group" aria-label={groupName(score, evaluated, phase)}>
      <Visual phase={phase} score={score} evaluated={evaluated} />
      <div className="score-state__text">
        <Text
          phase={phase}
          score={score}
          state={current}
          seconds={seconds}
          failure={failure}
          appliedBy={appliedBy}
          sending={request.isPending}
          noAgent={current?.agents_available === 0}
        />
        <Actions
          phase={phase}
          state={current}
          evaluated={evaluated}
          canAsk={prospectId !== null}
          cancelling={cancel.isPending}
          asking={request.isPending}
          onAsk={ask}
          onCancel={() => {
            cancel.mutate()
          }}
          onOpenDetail={onOpenDetail}
          onReview={setReviewing}
        />
      </div>
      <p className="visually-hidden" role="status" aria-live="polite">
        {announcement(phase, current)}
      </p>
      {prospectId && (
        <ReviewDialog
          key={reviewing ?? 'closed'}
          resultId={reviewing}
          onClose={() => {
            void reviewClosed()
          }}
        />
      )}
    </div>
  )
}

interface PhaseInput {
  current: Reassessment | undefined
  commandFailed: boolean
  sending: boolean
  evaluated: boolean
  appliedNow: boolean
  seconds: number
}

function phaseOf({ current, commandFailed, sending, evaluated, appliedNow, seconds }: PhaseInput): Phase {
  if (sending) return 'waiting'
  if (commandFailed) return 'failed'
  if (appliedNow) return 'applied'
  switch (current?.status) {
    case 'queued':
      return seconds >= QUEUE_TIMEOUT_SECONDS ? 'stalled' : 'waiting'
    case 'running':
      return seconds >= RUN_TIMEOUT_SECONDS ? 'stalled' : 'running'
    case 'proposal':
      return 'proposal'
    case 'failed':
      return 'failed'
    default:
      return evaluated ? 'idle' : 'unevaluated'
  }
}

function groupName(score: ProspectScore, evaluated: boolean, phase: Phase): string {
  if (phase === 'waiting' || phase === 'running') return 'Score prospect : évaluation en cours'
  if (!evaluated) return 'Score prospect : non évalué'
  return `Score prospect : ${String(score.total)} sur 100, niveau ${BAND_LABELS[score.band].toLowerCase()}`
}

function announcement(phase: Phase, state: Reassessment | undefined): string {
  switch (phase) {
    case 'waiting':
      return 'Demande envoyée. En attente d’un agent.'
    case 'running':
      return 'Évaluation en cours : un agent analyse la fiche.'
    case 'stalled':
      return 'Aucune réponse de l’agent pour le moment. Le score actuel reste valable.'
    case 'proposal':
      return state?.proposal
        ? `Proposition prête : score ${String(state.proposal.current_total)} vers ${String(state.proposal.projected_total)}.`
        : 'Proposition prête à relire.'
    case 'failed':
      return 'L’évaluation a échoué. Le score actuel reste valable.'
    case 'applied':
      return 'Proposition appliquée : le score a été mis à jour.'
    default:
      return ''
  }
}

function failureText(commandFailure: Error | null, state: Reassessment | undefined): string {
  if (commandFailure) {
    return commandFailure instanceof ApiError ? commandFailure.message : 'La demande n’a pas pu être envoyée.'
  }
  return state?.failure_message ?? 'L’agent n’a pas pu réévaluer le score.'
}

// --- left: the ring ----------------------------------------------------------------------------------------------

function Visual({ phase, score, evaluated }: { phase: Phase; score: ProspectScore; evaluated: boolean }) {
  if (phase === 'waiting' || phase === 'running' || phase === 'stalled') {
    return <ProgressRing mode={phase === 'running' ? 'run' : 'wait'} paused={phase === 'stalled'} />
  }
  if (!evaluated) {
    return (
      <span className="prospect-score__placeholder" aria-hidden="true">
        –
      </span>
    )
  }
  return (
    <span className="score-state__ring" data-just-applied={phase === 'applied' || undefined}>
      <ScoreRing value={score.total} tone={BAND_TONES[score.band]} />
    </span>
  )
}

// Same footprint as ScoreRing. Dashed segments turn slowly while an agent works, and only breathe while the task still
// waits for one; three dots sit inside. Both are decorative (the state is written next to it).
function ProgressRing({ mode, paused }: { mode: 'wait' | 'run'; paused: boolean }) {
  return (
    <span className="score-progress" data-mode={mode} data-paused={paused || undefined} aria-hidden="true">
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
  state: Reassessment | undefined
  seconds: number
  failure: string
  appliedBy: string | null | undefined
  sending: boolean
  noAgent: boolean
}

function Text({ phase, score, state, seconds, failure, appliedBy, sending, noAgent }: TextProps) {
  switch (phase) {
    case 'waiting':
      return (
        <>
          <p className="score-state__title">
            <span className="score-badge" data-tone="info">
              <i className="score-badge__dot" />
              {noAgent && !sending ? 'Aucun agent connecté' : 'En attente d’un agent'}
            </span>
          </p>
          <p className="score-state__detail">
            {sending ? 'Envoi de la demande…' : 'Demande en file'} ·{' '}
            <span className="score-state__timer">{formatElapsed(seconds)}</span>
          </p>
        </>
      )
    case 'running':
      return (
        <>
          <p className="score-state__title">
            <span className="score-badge" data-tone="success">
              <SparklesIcon size={13} />
              Évaluation en cours
            </span>
          </p>
          <p className="score-state__detail" title={state?.agent_label ?? undefined}>
            Analyse par l’agent… · <span className="score-state__timer">{formatElapsed(seconds)}</span>
          </p>
        </>
      )
    case 'stalled':
      return (
        <>
          <p className="score-state__title">
            <span className="score-badge" data-tone="warning">
              <AlertIcon size={13} />
              {state?.status === 'running' ? 'L’agent tarde' : 'Aucun agent n’a répondu'}
            </span>
          </p>
          <p className="score-state__detail">
            Sans réponse depuis <span className="score-state__timer">{formatElapsed(seconds)}</span>
          </p>
        </>
      )
    case 'proposal': {
      const proposal = state?.proposal
      return (
        <>
          <p className="score-state__title">
            {proposal ? (
              <>
                Proposition <span className="score-state__delta">{proposal.current_total} → <strong>{proposal.projected_total}</strong></span>
              </>
            ) : (
              'Proposition à relire'
            )}
          </p>
          <p className="score-state__detail" title={proposal?.rationale ?? undefined}>
            {proposal?.rationale ?? 'Le score ne change qu’une fois la proposition validée.'}
          </p>
        </>
      )
    }
    case 'failed':
      return (
        <>
          <p className="score-state__title" data-tone="danger">
            <AlertIcon size={14} />
            Évaluation échouée
          </p>
          <p className="score-state__detail" title={failure}>
            {failure} Score inchangé.
          </p>
        </>
      )
    case 'applied':
      return (
        <>
          <p className="score-state__title" data-tone="success">
            <CheckCircleIcon size={14} />
            Score mis à jour
          </p>
          <p className="score-state__detail">Proposition appliquée{appliedBy ? ` par ${appliedBy}` : ''}.</p>
        </>
      )
    case 'unevaluated':
      return (
        <>
          <p className="score-state__title" data-tone="muted">
            Non évalué
          </p>
          <p className="score-state__detail">{idleNote(state) ?? 'Aucun signal pour l’instant.'}</p>
        </>
      )
    default:
      return (
        <>
          <p className="score-state__title" data-tone="band">
            {BAND_LABELS[score.band]}
          </p>
          <p className="score-state__detail" title={score.summary}>
            {idleNote(state) ?? score.summary}
          </p>
        </>
      )
  }
}

// What the last closed attempt left to say, replacing the summary line for the time being (never a new block).
function idleNote(state: Reassessment | undefined): string | null {
  switch (state?.status) {
    case 'rejected':
      return 'Proposition refusée : score inchangé.'
    case 'nothing_found':
      return 'L’agent n’a rien trouvé qui change le score.'
    default:
      return null
  }
}

interface ActionsProps {
  phase: Phase
  state: Reassessment | undefined
  evaluated: boolean
  canAsk: boolean
  cancelling: boolean
  asking: boolean
  onAsk: () => void
  onCancel: () => void
  onOpenDetail: () => void
  onReview: (resultId: string) => void
}

function Actions({ phase, state, evaluated, canAsk, cancelling, asking, onAsk, onCancel, onOpenDetail, onReview }: ActionsProps) {
  const cancelLink = (
    <button type="button" className="score-state__link" disabled={cancelling || asking} onClick={onCancel} aria-label="Annuler la demande d’évaluation">
      Annuler
    </button>
  )
  switch (phase) {
    case 'waiting':
    case 'running':
    case 'stalled':
      return <div className="score-state__actions">{cancelLink}</div>
    case 'proposal':
      return (
        <div className="score-state__actions">
          <Button
            size="sm"
            variant="primary"
            disabled={!state?.result_id}
            onClick={() => {
              if (state?.result_id) onReview(state.result_id)
            }}
          >
            Relire et appliquer
          </Button>
          {cancelLink}
        </div>
      )
    case 'failed':
      return (
        <div className="score-state__actions">
          <Button size="sm" variant="secondary" icon={SparklesIcon} loading={asking} disabled={!canAsk} onClick={onAsk}>
            Réessayer
          </Button>
        </div>
      )
    case 'applied':
      return (
        <div className="score-state__actions">
          <button type="button" className="prospect-score__more" onClick={onOpenDetail}>
            Voir le détail
            <ChevronRightIcon size={14} />
          </button>
        </div>
      )
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
          <button type="button" className="prospect-score__more" aria-haspopup="dialog" onClick={onOpenDetail}>
            Voir le détail
            <ChevronRightIcon size={14} />
          </button>
          {canAsk && (
            <Button
              size="sm"
              variant="ghost"
              icon={SparklesIcon}
              aria-label="Réévaluer le score"
              title="Un agent relit la fiche et propose des ajustements sourcés (adéquation commerciale uniquement). Rien ne change avant votre validation."
              onClick={onAsk}
            >
              {evaluated ? 'Réévaluer' : 'Évaluer'}
            </Button>
          )}
        </div>
      )
  }
}

function useElapsedSeconds(since: string | null): number {
  const [mounted] = useState(() => Date.now())
  const [now, setNow] = useState(mounted)
  const active = since !== null
  useEffect(() => {
    if (!active) return undefined
    const timer = setInterval(() => {
      setNow(Date.now())
    }, 1000)
    return () => {
      clearInterval(timer)
    }
  }, [active])
  const start = since ? new Date(since).getTime() : mounted
  return Math.max(0, Math.floor((now - start) / 1000))
}

export function formatElapsed(seconds: number): string {
  const minutes = Math.floor(seconds / 60)
  const rest = seconds % 60
  return minutes > 0 ? `${String(minutes)} min ${String(rest).padStart(2, '0')} s` : `${String(rest)} s`
}
