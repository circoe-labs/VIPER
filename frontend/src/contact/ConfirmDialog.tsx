import { useRef } from 'react'

import type { DispatchReason } from '../api/contact'
import { Button } from '../ui/Button'
import { Modal } from '../ui/Dialog'
import { DispatchWarning } from './DispatchWarning'

export interface Confirmation {
  title: string
  lines: string[]
  // A remark that does not block (e.g. R1 scheduled while Contact has not left).
  warning?: string | null
  // S9: the scheduled message will not leave (automatic sending inactive): the reason and the link that fixes it.
  dispatch?: { reason: DispatchReason | null; text: string }
  confirmLabel: string
  // Destructive confirmations use the danger button.
  danger?: boolean
}

interface ConfirmDialogProps {
  confirmation: Confirmation | null
  busy: boolean
  onConfirm: () => void
  onClose: () => void
}

// A short confirmation before an action a person must own (validate, schedule, cancel, a sequence-closing state):
// the consequences in plain sentences, « Retour » focused first so Enter never confirms by accident.
export function ConfirmDialog({ confirmation, busy, onConfirm, onClose }: ConfirmDialogProps) {
  const backRef = useRef<HTMLButtonElement>(null)
  return (
    <Modal
      open={confirmation !== null}
      size="sm"
      title={confirmation?.title ?? ''}
      initialFocusRef={backRef}
      onClose={onClose}
      footer={
        <>
          <Button ref={backRef} disabled={busy} onClick={onClose}>
            Retour
          </Button>
          <Button variant={confirmation?.danger ? 'danger' : 'primary'} loading={busy} onClick={onConfirm}>
            {confirmation?.confirmLabel}
          </Button>
        </>
      }
    >
      <div className="contact-confirm">
        {confirmation?.lines.map((line) => <p key={line}>{line}</p>)}
        {confirmation?.warning && <p className="contact-confirm__warning">{confirmation.warning}</p>}
        {confirmation?.dispatch && (
          <DispatchWarning reason={confirmation.dispatch.reason}>{confirmation.dispatch.text}</DispatchWarning>
        )}
      </div>
    </Modal>
  )
}
