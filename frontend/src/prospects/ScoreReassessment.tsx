import { useQueryClient } from '@tanstack/react-query'
import { useEffect, useState } from 'react'

import { ReviewDialog } from '../agents/ReviewDialog'
import { ApiError } from '../api/client'
import {
  type Reassessment,
  reassessmentKeys,
  refreshScore,
  useReassessmentCommands,
  useScoreReassessment,
  WAITING_STATUSES,
} from '../api/scoreReassessment'
import { Button } from '../ui/Button'
import { AlertIcon, CheckCircleIcon, ClockIcon, SparklesIcon } from '../ui/icons'
import { InfoTip } from '../ui/InfoTip'
import { StatusBadge } from '../ui/Badge'
import './score-reassessment.css'

// After this long without an answer the card says so and keeps the way out (cancel) in sight.
export const SLOW_AFTER_SECONDS = 10 * 60

interface ScoreReassessmentProps {
  prospectId: string
  // The prospect already has a score from signals: the action reads « Réévaluer le score »; otherwise « Évaluer ».
  evaluated?: boolean
  // The score changed (a proposal was applied): the editor may refresh what it derives from it.
  onScoreChanged?: () => void
}

// « Réévaluer le score » (S4): asks a VIPER agent, through a one-off mission bound to this prospect, to reassess the
// commercial fit. The agent only proposes; the person reads the proposal in the ordinary result review and applies it
// (the only way the score moves). Every state is written: waiting (with a live counter and a cancel), proposal ready,
// failure (with the real reason), nothing found, applied. A failure never touches the current score.
export function ScoreReassessment({ prospectId, evaluated = true, onScoreChanged }: ScoreReassessmentProps) {
  const queryClient = useQueryClient()
  const state = useScoreReassessment(prospectId)
  const { request, cancel } = useReassessmentCommands(prospectId)
  const [reviewing, setReviewing] = useState<string | null>(null)
  const [applied, setApplied] = useState(false)

  const current = state.data
  const waiting = current !== undefined && WAITING_STATUSES.includes(current.status)
  const busy = request.isPending || cancel.isPending || waiting || current?.status === 'proposal'
  const commandFailure = request.error ?? cancel.error

  function ask() {
    setApplied(false)
    request.mutate({})
  }

  async function reviewClosed() {
    setReviewing(null)
    await refreshScore(queryClient, prospectId)
    const next = queryClient.getQueryData<Reassessment>(reassessmentKeys.detail(prospectId))
    if (next?.status === 'applied') {
      setApplied(true)
      onScoreChanged?.()
    }
  }

  return (
    <div className="score-reassessment">
      <div className="score-reassessment__bar">
        <Button size="sm" variant="secondary" icon={SparklesIcon} loading={request.isPending} disabled={busy} onClick={ask}>
          {evaluated ? 'Réévaluer le score' : 'Évaluer'}
        </Button>
        <InfoTip label={evaluated ? 'Aide : réévaluer le score' : 'Aide : évaluer le score'}>
          Un agent VIPER relit la fiche et l’entreprise et propose des ajustements sourcés du score (adéquation commerciale
          uniquement, sans le réseau de relations). Rien ne change tant que vous n’avez pas validé la proposition.
        </InfoTip>
      </div>
      <div className="score-reassessment__state" aria-live="polite">
        {state.isError && (
          <p className="score-reassessment__line" data-tone="danger" role="alert">
            <AlertIcon size={14} />
            L’état de la réévaluation n’a pas pu être lu. Le score actuel reste valable.
          </p>
        )}
        {commandFailure && (
          <p className="score-reassessment__line" data-tone="danger" role="alert">
            <AlertIcon size={14} />
            {commandFailure instanceof ApiError ? commandFailure.message : 'La demande n’a pas pu être envoyée.'} Le score
            actuel reste valable.
          </p>
        )}
        {current && <StateLine state={current} applied={applied} onCancel={() => { cancel.mutate() }} cancelling={cancel.isPending} onReview={setReviewing} />}
      </div>
      <ReviewDialog
        key={reviewing ?? 'closed'}
        resultId={reviewing}
        onClose={() => {
          void reviewClosed()
        }}
      />
    </div>
  )
}

interface StateLineProps {
  state: Reassessment
  applied: boolean
  cancelling: boolean
  onCancel: () => void
  onReview: (resultId: string) => void
}

function StateLine({ state, applied, cancelling, onCancel, onReview }: StateLineProps) {
  switch (state.status) {
    case 'queued':
    case 'running':
      return <Waiting state={state} cancelling={cancelling} onCancel={onCancel} />
    case 'proposal':
      return <Proposal state={state} cancelling={cancelling} onCancel={onCancel} onReview={onReview} />
    case 'failed':
      return (
        <p className="score-reassessment__line" data-tone="danger" role="alert">
          <AlertIcon size={14} />
          L’agent n’a pas pu réévaluer le score{state.failure_message ? ` : ${state.failure_message}` : ''}. Le score actuel reste
          valable.
        </p>
      )
    case 'rejected':
      return (
        <p className="score-reassessment__line" data-tone="muted">
          <AlertIcon size={14} />
          Proposition refusée : le score est inchangé. Vous pouvez relancer une réévaluation.
        </p>
      )
    case 'nothing_found':
      return (
        <p className="score-reassessment__line" data-tone="muted">
          <CheckCircleIcon size={14} />
          L’agent n’a rien trouvé qui change le score.
        </p>
      )
    case 'applied':
      return applied ? (
        <p className="score-reassessment__line" data-tone="success" role="status">
          <CheckCircleIcon size={14} />
          Proposition appliquée{state.decided_by ? ` par ${state.decided_by}` : ''} : le score a été mis à jour.
        </p>
      ) : null
    default:
      return null
  }
}

function Waiting({ state, cancelling, onCancel }: { state: Reassessment; cancelling: boolean; onCancel: () => void }) {
  const seconds = useElapsedSeconds(state.requested_at)
  const slow = seconds >= SLOW_AFTER_SECONDS
  const what =
    state.status === 'running'
      ? `${state.agent_label ?? 'Un agent'} réévalue le score…`
      : 'En attente d’un agent pour réévaluer le score…'
  return (
    <div className="score-reassessment__wait" role="status">
      <p className="score-reassessment__line" data-tone="info">
        <ClockIcon size={14} />
        <span>
          {what} <span className="score-reassessment__timer">{formatElapsed(seconds)}</span>
        </span>
      </p>
      {state.failure_message && (
        <p className="score-reassessment__line" data-tone="warning">
          <AlertIcon size={14} />
          Dernière tentative interrompue : {state.failure_message}
        </p>
      )}
      {slow && (
        <p className="score-reassessment__line" data-tone="warning">
          <AlertIcon size={14} />
          Toujours sans réponse après {formatElapsed(SLOW_AFTER_SECONDS)} : aucun agent n’a pris la demande. Le score actuel reste
          valable ; annulez et relancez plus tard si besoin.
        </p>
      )}
      <Button size="sm" variant="ghost" loading={cancelling} onClick={onCancel}>
        Annuler la demande
      </Button>
    </div>
  )
}

function Proposal({
  state,
  cancelling,
  onCancel,
  onReview,
}: {
  state: Reassessment
  cancelling: boolean
  onCancel: () => void
  onReview: (resultId: string) => void
}) {
  const proposal = state.proposal
  const resultId = state.result_id
  const count = proposal?.items.length ?? 0
  return (
    <div className="score-reassessment__proposal" role="status">
      <p className="score-reassessment__headline">
        <StatusBadge tone="info">Proposition à relire</StatusBadge>
        {proposal && (
          <span>
            Score {proposal.current_total} → <strong>{proposal.projected_total}</strong> si tout est retenu ({count}{' '}
            {count > 1 ? 'contributions' : 'contribution'})
          </span>
        )}
      </p>
      {proposal?.rationale && <p className="score-reassessment__rationale">{proposal.rationale}</p>}
      <p className="score-reassessment__actions">
        <Button
          size="sm"
          variant="primary"
          disabled={!resultId}
          onClick={() => {
            if (resultId) onReview(resultId)
          }}
        >
          Relire et appliquer
        </Button>
        <Button size="sm" variant="ghost" loading={cancelling} onClick={onCancel}>
          Annuler la demande
        </Button>
        <InfoTip label="Aide : proposition">
          Le score ne change qu’une fois la proposition validée. Vous pouvez ne retenir que certaines contributions ou tout refuser.
        </InfoTip>
      </p>
    </div>
  )
}

function useElapsedSeconds(since: string | null): number {
  const [mounted] = useState(() => Date.now())
  const [now, setNow] = useState(mounted)
  const start = since ? new Date(since).getTime() : mounted
  useEffect(() => {
    const timer = setInterval(() => {
      setNow(Date.now())
    }, 1000)
    return () => {
      clearInterval(timer)
    }
  }, [])
  return Math.max(0, Math.floor((now - start) / 1000))
}

export function formatElapsed(seconds: number): string {
  const minutes = Math.floor(seconds / 60)
  const rest = seconds % 60
  return minutes > 0 ? `${String(minutes)} min ${String(rest).padStart(2, '0')} s` : `${String(rest)} s`
}
