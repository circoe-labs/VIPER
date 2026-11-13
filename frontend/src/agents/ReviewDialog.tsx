import { useState } from 'react'

import { useAcceptResult, useRebuildResult, useRejectResult, useResult } from '../api/agents'
import { ApiError } from '../api/client'
import { StatusBadge } from '../ui/Badge'
import { Button } from '../ui/Button'
import { Modal } from '../ui/Dialog'
import { ReviewDecision } from './ReviewDecision'
import { ReviewProposalTable } from './ReviewProposalTable'
import { DiscoveryDetails, SignalRow } from './ReviewItems'
import { ReviewSummary } from './ReviewSummary'
import { TASK_TYPE_LABELS, sinceLabel } from './labels'
import { safeHref } from './reviewFormat'
import './agents.css'
import './review.css'

const DECIDED_LABELS = {
  accepted: 'Validé',
  rejected: 'Rejeté',
  superseded: 'Remplacé par un résultat plus récent',
} as const

// Validation dialog of an agent result (Slice 08): global confidence and research report first, then each proposed
// value with its own evidence, then the decision. Human acceptance stays the only way a proposal is applied; a result
// already decided opens read-only. Callers `key` the component on the result id so the selection starts fresh.
export function ReviewDialog({
  resultId,
  onClose,
}: {
  resultId: string | null
  onClose: () => void
}) {
  const result = useResult(resultId)
  const accept = useAcceptResult(resultId ?? '')
  const reject = useRejectResult(resultId ?? '')
  const rebuild = useRebuildResult(resultId ?? '')
  // `null` means "everything the agent proposed": the selection follows the proposal until the
  // person unchecks something, so no effect has to copy the item list into state.
  const [chosen, setChosen] = useState<Set<string> | null>(null)
  const [rejecting, setRejecting] = useState(false)

  const failure = accept.error ?? reject.error ?? rebuild.error
  const busy = accept.isPending || reject.isPending || rebuild.isPending
  const view = result.data
  const proposal = view?.proposal
  const decided = view && view.status !== 'pending_review' ? view.status : null
  const keys = proposal?.items.map((item) => item.key) ?? []
  const selected = decided ? new Set(view?.accepted_items?.keys ?? []) : (chosen ?? new Set(keys))
  const sources = new Set(proposal?.items.map((item) => safeHref(item.source)).filter(Boolean)).size

  const toggle = (key: string) => {
    const next = new Set(selected)
    if (next.has(key)) next.delete(key)
    else next.add(key)
    setChosen(next)
  }

  // Esc during a rejection backs out of the reason field instead of closing the whole review.
  const close = () => {
    if (rejecting && !busy) setRejecting(false)
    else onClose()
  }

  const subject = view?.company_name ?? view?.prospect_name
  const description = view
    ? [subject, view.submitted_by_label, sinceLabel(view.submitted_at)].filter(Boolean).join(' · ')
    : undefined
  const failureText = failure instanceof ApiError ? failure.message : 'La décision n’a pas pu être enregistrée.'

  return (
    <Modal
      open={Boolean(resultId)}
      onClose={close}
      size="lg"
      title={view ? TASK_TYPE_LABELS[view.task_type] : 'Résultat'}
      description={description}
      footer={
        view && !decided ? (
          <div className="review-footer">
            {failure && (
              <p className="agents-error" role="alert">
                {failureText}
              </p>
            )}
            <ReviewDecision
              rejecting={rejecting}
              busy={busy}
              acceptPending={accept.isPending}
              rejectPending={reject.isPending}
              selectedCount={selected.size}
              onStartReject={() => {
                setRejecting(true)
              }}
              onCancelReject={() => {
                setRejecting(false)
              }}
              onReject={(reason) => {
                reject.mutate(reason, { onSuccess: onClose })
              }}
              onAccept={() => {
                accept.mutate({ accepted_items: [...selected] }, { onSuccess: onClose })
              }}
            />
          </div>
        ) : undefined
      }
    >
      {result.isLoading && (
        <p className="agents-muted" role="status">
          Chargement…
        </p>
      )}
      {result.isError && (
        <p className="agents-error" role="alert">
          Le résultat n’a pas pu être chargé.
        </p>
      )}
      {view && proposal && (
        <div className="review">
          <ReviewSummary result={view} sources={sources} />
          {decided && (
            <p className="agents-notice" role="status">
              <StatusBadge tone={decided === 'accepted' ? 'success' : 'neutral'}>{DECIDED_LABELS[decided]}</StatusBadge>{' '}
              {[view.decided_by_display, sinceLabel(view.decided_at)].filter(Boolean).join(' · ')}
              {view.decision_note ? ` — ${view.decision_note}` : ''}
            </p>
          )}
          {proposal.stale && !decided && (
            <p className="agents-notice">
              La fiche a changé depuis la prise de la tâche : vérifiez les valeurs « avant ».
            </p>
          )}
          {proposal.items.length === 0 ? (
            <p className="agents-muted">Aucune proposition exploitable : tout a été écarté.</p>
          ) : proposal.kind === 'signals' ? (
            <ul className="review-signals" aria-label="Propositions">
              {proposal.items.map((item) => (
                <SignalRow
                  key={item.key}
                  item={item}
                  checked={selected.has(item.key)}
                  locked={decided !== null}
                  onToggle={() => {
                    toggle(item.key)
                  }}
                />
              ))}
            </ul>
          ) : (
            <ReviewProposalTable
              items={proposal.items}
              selected={selected}
              locked={decided !== null}
              onToggle={toggle}
              detail={(item) =>
                proposal.kind === 'find_prospects' || item.action_operation === 'add_company' ? (
                  <DiscoveryDetails item={item} />
                ) : null
              }
            />
          )}
          {proposal.refused.length > 0 && (
            <div className="review-refused">
              <StatusBadge tone="danger">{String(proposal.refused.length)} valeur(s) écartée(s)</StatusBadge>
              <ul>
                {proposal.refused.map((item) => (
                  <li key={item.field}>
                    <strong>{item.label}</strong> — {item.message} ({item.reason})
                  </li>
                ))}
              </ul>
              {!decided && view.task_type === 'find_prospects' && !('actions' in view.raw) && (
                <Button
                  disabled={busy}
                  loading={rebuild.isPending}
                  onClick={() => {
                    rebuild.mutate(undefined, {
                      onSuccess: () => {
                        setChosen(null)
                      },
                    })
                  }}
                >
                  Recalculer la prévisualisation
                </Button>
              )}
            </div>
          )}
          <details className="review-json">
            <summary>JSON soumis par l’agent</summary>
            <pre>{JSON.stringify(view.raw, null, 2)}</pre>
          </details>
        </div>
      )}
    </Modal>
  )
}
