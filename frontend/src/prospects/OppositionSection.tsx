import { useId, useRef, useState } from 'react'

import type { Prospect } from '../api/prospects'
import { formatDay } from '../prospection/labels'
import { StatusBadge } from '../ui/Badge'
import { Button } from '../ui/Button'
import { Modal } from '../ui/Dialog'
import { TextAreaField } from '../ui/fields'
import { AlertIcon, BanIcon, CheckCircleIcon } from '../ui/icons'
import { EditorSection } from './EditorSection'

interface OppositionSectionProps {
  // Null for a prospect not saved yet.
  prospect: Prospect | null
  busy: boolean
  // The form has unsaved changes (they are not saved by this operation).
  pendingChanges: boolean
  // Records or lifts the opposition (its own audited operation); rejects with the French message to show.
  onSubmit: (doNotContact: boolean, reason: string) => Promise<void>
}

// Durable do-not-contact: independent of the activity status and of the contact-tracking stage (« Pas intéressé » is
// an outcome, not an opposition). Set and lifted only through a confirmation with a reason, never by the form's save.
export function OppositionSection({ prospect, busy, pendingChanges, onSubmit }: OppositionSectionProps) {
  const [dialog, setDialog] = useState<'set' | 'clear' | null>(null)
  const blocked = prospect?.contactability_status === 'do_not_contact'
  return (
    <EditorSection title="Opposition" tone={blocked ? 'danger' : undefined}>
      {blocked ? (
        <div className="prospect-opposition prospect-opposition--blocked">
          <StatusBadge tone="danger" icon={BanIcon}>
            Ne pas contacter
          </StatusBadge>
          <p>
            Opposition enregistrée
            {prospect.do_not_contact_at ? ` le ${formatDay(prospect.do_not_contact_at)}` : ''}.
            {prospect.do_not_contact_reason && (
              <>
                {' '}
                Motif : <q>{prospect.do_not_contact_reason}</q>
              </>
            )}
          </p>
          <div>
            <Button
              size="sm"
              onClick={() => {
                setDialog('clear')
              }}
            >
              Lever l’opposition…
            </Button>
          </div>
        </div>
      ) : (
        <div className="prospect-opposition">
          <p className="prospect-opposition__state">
            <CheckCircleIcon size={16} />
            Contactable : aucune opposition enregistrée.
          </p>
          <p className="prospect-editor__muted">
            Une opposition est durable : la personne sort des contacts à faire, même après un nouvel import.
          </p>
          {prospect ? (
            <div>
              <Button
                size="sm"
                variant="ghost"
                icon={BanIcon}
                onClick={() => {
                  setDialog('set')
                }}
              >
                Enregistrer une opposition…
              </Button>
            </div>
          ) : (
            <p className="prospect-editor__muted">Possible une fois le prospect enregistré.</p>
          )}
        </div>
      )}
      {dialog && (
        <OppositionDialog
          lifting={dialog === 'clear'}
          busy={busy}
          pendingChanges={pendingChanges}
          onClose={() => {
            setDialog(null)
          }}
          onSubmit={async (reason) => {
            await onSubmit(dialog === 'set', reason)
            setDialog(null)
          }}
        />
      )}
    </EditorSection>
  )
}

interface OppositionDialogProps {
  lifting: boolean
  busy: boolean
  pendingChanges: boolean
  onClose: () => void
  onSubmit: (reason: string) => Promise<void>
}

function OppositionDialog({ lifting, busy, pendingChanges, onClose, onSubmit }: OppositionDialogProps) {
  const formId = useId()
  const reasonRef = useRef<HTMLTextAreaElement>(null)
  const [reason, setReason] = useState('')
  const [error, setError] = useState<string | null>(null)
  async function submit() {
    if (!reason.trim()) {
      setError('Indiquez le motif.')
      return
    }
    try {
      await onSubmit(reason.trim())
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'L’opération a échoué.')
    }
  }
  return (
    <Modal
      open
      size="md"
      title={lifting ? 'Lever l’opposition ?' : 'Enregistrer une opposition ?'}
      initialFocusRef={reasonRef}
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Annuler</Button>
          <Button type="submit" form={formId} variant={lifting ? 'primary' : 'danger'} loading={busy}>
            {lifting ? 'Lever l’opposition' : 'Enregistrer l’opposition'}
          </Button>
        </>
      }
    >
      <form
        id={formId}
        className="prospect-editor__dialog"
        noValidate
        onSubmit={(event) => {
          event.preventDefault()
          // React events cross portals: the editor's own form must not submit (save) too.
          event.stopPropagation()
          void submit()
        }}
      >
        {lifting ? (
          <p>
            La personne redeviendra contactable et pourra de nouveau être proposée dans les contacts à faire. Le motif
            est conservé dans l’historique.
          </p>
        ) : (
          <p>
            La personne ne sera plus proposée à contacter, même après un nouvel import. Son activité et son suivi de
            contact ne changent pas. L’opposition ne pourra être levée qu’avec un motif.
          </p>
        )}
        <TextAreaField
          label={lifting ? 'Pourquoi lever l’opposition ?' : 'Motif de l’opposition'}
          hint="Restez factuel : ce texte est conservé dans l’historique."
          required
          rows={3}
          ref={reasonRef}
          value={reason}
          error={error ?? undefined}
          onChange={(event) => {
            setReason(event.target.value)
            setError(null)
          }}
        />
        {pendingChanges && (
          <p className="prospect-editor__note">
            <AlertIcon size={16} />
            Cette opération est enregistrée seule : vos autres modifications restent à enregistrer.
          </p>
        )}
      </form>
    </Modal>
  )
}
