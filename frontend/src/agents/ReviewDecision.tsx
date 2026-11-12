import { useEffect, useRef, useState } from 'react'

import { Button } from '../ui/Button'
import { TextAreaField } from '../ui/fields'

interface ReviewDecisionProps {
  rejecting: boolean
  busy: boolean
  acceptPending: boolean
  rejectPending: boolean
  selectedCount: number
  onStartReject: () => void
  onCancelReject: () => void
  onReject: (reason: string) => void
  onAccept: () => void
}

// Footer of the review. Normal review shows only « Rejeter » and « Accepter la sélection ». The rejection reason is
// asked only once the person has chosen to reject: then the field appears (focused) with « Annuler » and « Confirmer
// le rejet ». Cancelling hands focus back to « Rejeter ». Accepting never asks for a reason.
export function ReviewDecision({
  rejecting,
  busy,
  acceptPending,
  rejectPending,
  selectedCount,
  onStartReject,
  onCancelReject,
  onReject,
  onAccept,
}: ReviewDecisionProps) {
  const [reason, setReason] = useState('')
  const rejectButton = useRef<HTMLButtonElement>(null)
  const reasonField = useRef<HTMLTextAreaElement>(null)
  const wasRejecting = useRef(false)

  useEffect(() => {
    if (rejecting) reasonField.current?.focus()
    else if (wasRejecting.current) rejectButton.current?.focus()
    wasRejecting.current = rejecting
  }, [rejecting])

  if (rejecting) {
    return (
      <form
        className="review-reject"
        onSubmit={(event) => {
          event.preventDefault()
          if (reason.trim() !== '' && !busy) onReject(reason.trim())
        }}
      >
        <TextAreaField
          ref={reasonField}
          label="Motif du rejet"
          hint="Obligatoire : l’agent et l’équipe le retrouvent dans l’historique."
          required
          rows={2}
          value={reason}
          onChange={(event) => {
            setReason(event.target.value)
          }}
        />
        <div className="review-actions">
          <Button
            disabled={busy}
            onClick={() => {
              setReason('')
              onCancelReject()
            }}
          >
            Annuler
          </Button>
          <Button type="submit" variant="danger" disabled={busy || reason.trim() === ''} loading={rejectPending}>
            Confirmer le rejet
          </Button>
        </div>
      </form>
    )
  }
  return (
    <div className="review-actions">
      <Button ref={rejectButton} variant="danger" disabled={busy} onClick={onStartReject}>
        Rejeter
      </Button>
      <Button variant="primary" disabled={busy || selectedCount === 0} loading={acceptPending} onClick={onAccept}>
        Accepter la sélection ({String(selectedCount)})
      </Button>
    </div>
  )
}
