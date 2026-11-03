import { useState } from 'react'

import { type ProposalItem, useAcceptResult, useRejectResult, useResult } from '../api/agents'
import { ApiError } from '../api/client'
import { StatusBadge } from '../ui/Badge'
import { Button } from '../ui/Button'
import { Modal } from '../ui/Dialog'
import { SIGNAL_KIND_LABELS, TASK_TYPE_LABELS, sinceLabel } from './labels'
import './agents.css'

function shown(value: unknown): string {
  if (value === null || value === undefined || value === '') return '—'
  if (Array.isArray(value)) {
    return value.length === 0 ? '—' : value.map((item) => shown(item)).join(', ')
  }
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return value.toString()
  return JSON.stringify(value)
}

function signalValue(item: ProposalItem, key: string): string {
  const value = item.store?.[key]
  return typeof value === 'string' ? value : ''
}

function SignalRow({
  item,
  checked,
  onToggle,
}: {
  item: ProposalItem
  checked: boolean
  onToggle: () => void
}) {
  const kind = signalValue(item, 'kind')
  const subject = signalValue(item, 'subject') || item.label
  const unresolved = signalValue(item, 'unresolved_person')
  const observed = signalValue(item, 'observed_on')
  const score = item.store?.score_delta
  const relevance = item.store?.relevance
  return (
    <li className="review-signal">
      <label className="review-item__check">
        <input type="checkbox" checked={checked} onChange={onToggle} />
        <span className="review-signal__kind">{SIGNAL_KIND_LABELS[kind] ?? kind}</span>
      </label>
      <div className="review-signal__main">
        <p className="review-signal__subject">
          {subject}
          {unresolved && <span className="review-signal__unresolved"> · personne non reconnue</span>}
        </p>
        <p className="review-signal__text">{shown(item.after)}</p>
        <p className="review-signal__meta">
          {observed && <span>{observed}</span>}
          {typeof score === 'number' && (
            <span className={score < 0 ? 'review-signal__score is-negative' : 'review-signal__score'}>
              {score > 0 ? '+' : ''}
              {String(score)}
            </span>
          )}
          {typeof relevance === 'number' && <span>pertinence {String(relevance)}</span>}
          {item.quote && <span>{item.quote}</span>}
        </p>
      </div>
      {item.source ? (
        <a href={item.source} target="_blank" rel="noreferrer noopener">
          source
        </a>
      ) : (
        <span>—</span>
      )}
    </li>
  )
}

function ItemRow({
  item,
  checked,
  onToggle,
}: {
  item: ProposalItem
  checked: boolean
  onToggle: () => void
}) {
  return (
    <li className="review-item">
      <label className="review-item__check">
        <input type="checkbox" checked={checked} onChange={onToggle} />
        <span className="review-item__label">{item.label}</span>
      </label>
      <span className="review-item__before">{shown(item.before)}</span>
      <span className={`review-item__after review-item__after--${item.status}`}>{shown(item.after)}</span>
      <span className="review-item__source">
        {item.source ? (
          <a href={item.source} target="_blank" rel="noreferrer noopener">
            source
          </a>
        ) : (
          '—'
        )}
      </span>
    </li>
  )
}

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
  // `null` means "everything the agent proposed": the selection follows the proposal until the
  // person unchecks something, so no effect has to copy the item list into state.
  const [chosen, setChosen] = useState<Set<string> | null>(null)
  const [reason, setReason] = useState('')

  const failure = accept.error ?? reject.error
  const busy = accept.isPending || reject.isPending
  const proposal = result.data?.proposal
  const keys = proposal?.items.map((item) => item.key) ?? []
  const selected = chosen ?? new Set(keys)

  const toggle = (key: string) => {
    const next = new Set(selected)
    if (next.has(key)) next.delete(key)
    else next.add(key)
    setChosen(next)
  }

  return (
    <Modal
      open={Boolean(resultId)}
      onClose={onClose}
      size="lg"
      title={result.data ? TASK_TYPE_LABELS[result.data.task_type] : 'Résultat'}
      description={
        result.data
          ? `${result.data.submitted_by_label} · ${sinceLabel(result.data.submitted_at) ?? ''} · confiance ${String(proposal?.confidence ?? 0)} %`
          : undefined
      }
      footer={
        <div className="review-actions">
          <Button
            variant="danger"
            disabled={busy || reason.trim() === ''}
            loading={reject.isPending}
            onClick={() => {
              reject.mutate(reason, { onSuccess: onClose })
            }}
          >
            Rejeter
          </Button>
          <Button
            variant="primary"
            disabled={busy || selected.size === 0}
            loading={accept.isPending}
            onClick={() => {
              accept.mutate({ accepted_items: [...selected] }, { onSuccess: onClose })
            }}
          >
            Accepter la sélection ({String(selected.size)})
          </Button>
        </div>
      }
    >
      {result.isLoading && <p className="agents-muted">Chargement…</p>}
      {result.isError && <p className="agents-error">Le résultat n’a pas pu être chargé.</p>}
      {proposal && (
        <div className="review">
          {proposal.stale && (
            <p className="agents-notice">
              La fiche a changé depuis la prise de la tâche : vérifiez les valeurs « avant ».
            </p>
          )}
          {proposal.items.length === 0 ? (
            <p className="agents-muted">Aucune proposition exploitable : tout a été écarté.</p>
          ) : proposal.kind === 'signals' ? (
            <ul className="review-signals">
              {proposal.items.map((item) => (
                <SignalRow
                  key={item.key}
                  item={item}
                  checked={selected.has(item.key)}
                  onToggle={() => {
                    toggle(item.key)
                  }}
                />
              ))}
            </ul>
          ) : (
            <ul className="review-items">
              {proposal.items.map((item) => (
                <ItemRow
                  key={item.key}
                  item={item}
                  checked={selected.has(item.key)}
                  onToggle={() => {
                    toggle(item.key)
                  }}
                />
              ))}
            </ul>
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
            </div>
          )}
          <label className="review-reason">
            <span>Motif (obligatoire pour rejeter)</span>
            <textarea
              value={reason}
              onChange={(event) => {
                setReason(event.target.value)
              }}
              rows={2}
            />
          </label>
          {failure && (
            <p className="agents-error">
              {failure instanceof ApiError ? failure.message : 'La décision n’a pas pu être enregistrée.'}
            </p>
          )}
        </div>
      )}
    </Modal>
  )
}
