import { useQueryClient } from '@tanstack/react-query'
import { useEffect, useRef, useState } from 'react'

import { MESSAGE_STEPS, type MessageSequence, type MessageStep, useMessageMutations, useMessageSequence } from '../api/contact'
import { historyKeys } from '../api/history'
import { refreshAfterWrite } from '../api/refresh'
import { EditorSection } from '../prospects/EditorSection'
import { Button } from '../ui/Button'
import { AlertIcon, SpinnerIcon } from '../ui/icons'
import { Tabs } from '../ui/Tabs'
import { STEP_LABELS } from './labels'
import { type AiInstruction, NO_INSTRUCTION } from './aiDraftModel'
import { MailEditor, type SendMoment } from './MailEditor'
import { dispatchState, formOf, isDirty, type MailForm, mailActions, releaseAvailableAt } from './mailModel'
import { MessageBadge } from './MessageBadge'

// The step to send next (derived from the real sends), opened first; Contact when finished, closed or beyond R2.
function firstStep(next: string | null | undefined): MessageStep {
  return MESSAGE_STEPS.find((step) => step === next) ?? 'contact'
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
// tab with unsaved changes, and the typed send moment is kept too); leaving the prospect with unsaved text asks first (Workbench.tsx).
export function MailSequence({ prospectId, onDirtyChange }: MailSequenceProps) {
  const query = useMessageSequence(prospectId)
  const mutations = useMessageMutations(prospectId)
  const [selected, setSelected] = useState<MessageStep | null>(null)
  const [drafts, setDrafts] = useState<Partial<Record<MessageStep, MailForm>>>({})
  // The send moment typed per step, kept across tab switches like the text.
  const [moments, setMoments] = useState<Partial<Record<MessageStep, SendMoment>>>({})
  // The AI « consigne » per step (S5), kept across tab switches like the text.
  const [instructions, setInstructions] = useState<Partial<Record<MessageStep, AiInstruction>>>({})
  const sequence = query.data
  // A status changed by the server itself (the dispatcher sent a message, S7) moves the list's message chips, the
  // counters and the history too: read them again, as after a person's write.
  const queryClient = useQueryClient()
  const statuses = sequence ? sequence.steps.map((entry) => entry.message?.status ?? '-').join('|') : null
  const seenStatuses = useRef(statuses)
  // A persistent live region says what the server did (« Message Contact envoyé. »), whatever editor is shown.
  const [serverNews, setServerNews] = useState('')
  useEffect(() => {
    if (statuses === null || seenStatuses.current === statuses) return
    const before = seenStatuses.current?.split('|') ?? null
    seenStatuses.current = statuses
    if (before === null) return
    const after = statuses.split('|')
    const news = MESSAGE_STEPS.flatMap((step, index) => {
      if (before[index] !== 'scheduled' || after[index] === 'scheduled') return []
      if (after[index] === 'sent') return [`Message ${STEP_LABELS[step]} envoyé.`]
      if (after[index] === 'validated') return [`Message ${STEP_LABELS[step]} revenu en Validé : envoi non effectué.`]
      return []
    })
    if (news.length > 0) setServerNews(news.join(' '))
    void refreshAfterWrite(queryClient, [
      ['contact', 'page'],
      ['contact', 'dashboard'],
      historyKeys.subject('prospects', prospectId),
    ])
  }, [statuses, queryClient, prospectId])

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
  const step = selected ?? firstStep(data.sequence.next_step)
  const message = messageOf(data, step)
  // A claim is judged at the moment the sequence was read (the polling of `useMessageSequence` reads it again).
  const clock = { now: query.dataUpdatedAt, claimTtlSeconds: data.defaults.dispatch_claim_ttl_seconds }
  const releaseFrom = releaseAvailableAt(message, data.defaults.dispatch_claim_ttl_seconds, query.dataUpdatedAt)
  const actions = mailActions(
    message,
    { state: data.sequence.state, doNotContact: data.sequence.do_not_contact, closed: data.sequence.closed },
    clock,
  )
  const saved = formOf(message, data.defaults)
  const draft = actions.editable ? drafts[step] : undefined

  return (
    <EditorSection title="Séquence mail">
      <p className="visually-hidden" role="status" aria-live="polite">
        {serverNews}
      </p>
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
          dispatch={dispatchState(message, clock)}
          releaseFrom={releaseFrom}
          saved={saved}
          form={draft ?? saved}
          mutations={mutations}
          onReload={() => void query.refetch()}
          when={moments[step] ?? { date: '', time: '' }}
          onWhen={(when) => {
            setMoments((current) => ({ ...current, [step]: when }))
          }}
          onForm={(form) => {
            setDrafts((current) => ({ ...current, [step]: form }))
          }}
          instruction={instructions[step] ?? NO_INSTRUCTION}
          onInstruction={(instruction) => {
            setInstructions((current) => ({ ...current, [step]: instruction }))
          }}
        />
      </Tabs>
    </EditorSection>
  )
}
