import { useEffect, useState } from 'react'

import { MESSAGE_STEPS, type MessageSequence, type MessageStep, useMessageMutations, useMessageSequence } from '../api/contact'
import type { TrackingStatus } from '../api/prospection'
import { EditorSection } from '../prospects/EditorSection'
import { Button } from '../ui/Button'
import { AlertIcon, SpinnerIcon } from '../ui/icons'
import { Tabs } from '../ui/Tabs'
import { STEP_LABELS } from './labels'
import { MailEditor } from './MailEditor'
import { formOf, isDirty, type MailForm, mailActions } from './mailModel'
import { MessageBadge } from './MessageBadge'

// The step the next action prepares, opened first (the R2 review and the closed states show Contact).
function firstStep(state: TrackingStatus | null): MessageStep {
  if (state === 'contacted') return 'r1'
  if (state === 'r1') return 'r2'
  return 'contact'
}

function messageOf(sequence: MessageSequence, step: MessageStep) {
  return sequence.steps.find((entry) => entry.step === step)?.message ?? null
}

interface MailSequenceProps {
  prospectId: string
  onDirtyChange: (dirty: boolean) => void
}

// The mail sequence of the workbench (decisions 20-24): three tabs Contact / R1 / R2, each with its message's status,
// and the editor of the selected step. Unsaved text is kept per step, so switching tabs loses nothing (a dot marks a
// tab with unsaved changes); leaving the prospect with unsaved text asks first (Workbench.tsx).
export function MailSequence({ prospectId, onDirtyChange }: MailSequenceProps) {
  const query = useMessageSequence(prospectId)
  const mutations = useMessageMutations(prospectId)
  const [selected, setSelected] = useState<MessageStep | null>(null)
  const [drafts, setDrafts] = useState<Partial<Record<MessageStep, MailForm>>>({})
  const sequence = query.data

  const context = sequence
    ? { state: sequence.sequence.state, doNotContact: sequence.sequence.do_not_contact, closed: sequence.sequence.closed }
    : null
  // A step counts as edited only while it can be edited: a message the server locked meanwhile shows its saved text.
  const dirtySteps = MESSAGE_STEPS.filter((step) => {
    const draft = drafts[step]
    if (!sequence || !context || !draft) return false
    const message = messageOf(sequence, step)
    return mailActions(message, context).editable && isDirty(draft, formOf(message, sequence.defaults))
  })
  const anyDirty = dirtySteps.length > 0
  useEffect(() => {
    onDirtyChange(anyDirty)
  }, [anyDirty, onDirtyChange])
  useEffect(
    () => () => {
      onDirtyChange(false)
    },
    [onDirtyChange],
  )

  if (query.isPending) {
    return (
      <EditorSection title="Séquence mail">
        <p className="contact-panel__status" role="status">
          <SpinnerIcon size={18} className="btn__spinner" />
          Chargement des messages…
        </p>
      </EditorSection>
    )
  }
  if (query.isError) {
    return (
      <EditorSection title="Séquence mail">
        <div className="contact-panel__error" role="alert">
          <AlertIcon size={16} />
          Messages indisponibles ({query.error.message}).
          <Button size="sm" onClick={() => void query.refetch()}>
            Réessayer
          </Button>
        </div>
      </EditorSection>
    )
  }

  const data = query.data
  const step = selected ?? firstStep(data.sequence.state)
  const message = messageOf(data, step)
  const actions = mailActions(message, { state: data.sequence.state, doNotContact: data.sequence.do_not_contact, closed: data.sequence.closed })
  const saved = formOf(message, data.defaults)
  const draft = actions.editable ? drafts[step] : undefined

  return (
    <EditorSection title="Séquence mail">
      <Tabs
        label="Étapes de la séquence"
        selected={step}
        onSelect={setSelected}
        tabs={MESSAGE_STEPS.map((id) => ({
          id,
          label: STEP_LABELS[id],
          extra: (
            <>
              <MessageBadge status={messageOf(data, id)?.status ?? null} />
              {dirtySteps.includes(id) && (
                <span className="contact-tab__dirty" title="Modifications non enregistrées">
                  <span className="visually-hidden">(modifications non enregistrées)</span>
                </span>
              )}
            </>
          ),
        }))}
      >
        <MailEditor
          key={step}
          step={step}
          sequence={data}
          message={message}
          actions={actions}
          saved={saved}
          form={draft ?? saved}
          mutations={mutations}
          onReload={() => void query.refetch()}
          onForm={(form) => {
            setDrafts((current) => ({ ...current, [step]: form }))
          }}
        />
      </Tabs>
    </EditorSection>
  )
}
