import { useQueryClient } from '@tanstack/react-query'
import { useEffect, useState } from 'react'

import { TRACKING_STATUSES, type TrackingStatus } from '../api/prospection'
import { refreshAfterWrite } from '../api/refresh'
import { type Prospect, prospectKeys, type TrackingPatch, useProspectMutations } from '../api/prospects'
import { formatDay, TRACKING_LABELS } from '../prospection/labels'
import { EditorSection } from '../prospects/EditorSection'
import { prospectRefusal } from '../prospects/messages'
import { Button } from '../ui/Button'
import { SelectField } from '../ui/fields'
import { AlertIcon, BanIcon } from '../ui/icons'
import { type Confirmation, ConfirmDialog } from './ConfirmDialog'
import { Notice } from './Notice'
import '../prospects/prospects.css'

// States that take the sequence out of the automatic actions (their unsent messages are cancelled). « Défaillant » is
// chosen through its own confirmed action (Séquence de contact), never here.
const CLOSING: readonly TrackingStatus[] = ['response_received', 'appointment_obtained', 'ignored']

const STATE_HINTS: Partial<Record<TrackingStatus, string>> = {
  neutral: 'La séquence reprend là où elle s’était arrêtée (le niveau est conservé).',
  response_received: 'Les messages non envoyés seront annulés.',
  appointment_obtained: 'Fin de la séquence : les messages non envoyés seront annulés.',
  ignored: 'Définitif : le prospect passe en « Ne pas contacter » et sort de Contact.',
}

export interface TrackingPlan {
  patch: TrackingPatch | null
  dirty: boolean
}

// The PATCH of a choice: the state when it changed, nothing otherwise (the next due date is derived, never sent).
export function trackingPlan(stored: TrackingStatus, draft: TrackingStatus): TrackingPlan {
  return draft === stored ? { patch: null, dirty: false } : { patch: { status: draft }, dirty: true }
}

function plural(count: number, word: string): string {
  return `${String(count)} ${word}${count > 1 ? 's' : ''}`
}

// The outcome of a saved change, said in the panel's live region.
export function savedNotice(saved: { cancelled_messages: number; in_flight_messages: number }): { text: string; warning: string | null } {
  const parts = ['Suivi enregistré.']
  if (saved.cancelled_messages > 0) {
    parts.push(`${plural(saved.cancelled_messages, 'message')} non envoyé${saved.cancelled_messages > 1 ? 's' : ''} annulé${saved.cancelled_messages > 1 ? 's' : ''}.`)
  }
  const flying = saved.in_flight_messages
  const warning =
    flying > 0
      ? `${flying > 1 ? `${String(flying)} messages étaient` : 'Un message était'} déjà en cours d’envoi : ${flying > 1 ? 'ils n’ont' : 'il n’a'} pas pu être arrêté${flying > 1 ? 's' : ''} et peu${flying > 1 ? 'vent' : 't'} encore partir.`
      : null
  return { text: parts.join(' '), warning }
}

function confirmationOf(status: TrackingStatus): Confirmation {
  const label = TRACKING_LABELS[status]
  const lines = [
    'Les messages non envoyés de la séquence seront annulés, s’il y en a. Les messages déjà envoyés restent consultables.',
  ]
  if (status === 'ignored') {
    lines.push('« Ignoré » est définitif : le prospect sera marqué « Ne pas contacter », sortira de Contact et son état ne pourra plus changer.')
  }
  return {
    title: `Passer à « ${label} » ?`,
    lines,
    confirmLabel: status === 'ignored' ? 'Confirmer « Ignoré » (définitif)' : `Confirmer « ${label} »`,
    danger: status === 'ignored',
  }
}

interface TrackingPanelProps {
  prospect: Prospect
  onDirtyChange: (dirty: boolean) => void
}

// The commercial state in the workbench, chosen by hand and saved through `PATCH /prospects/{id}/tracking` — never by a
// mail action. A sequence-closing state is confirmed first; the answer says how many unsent messages it cancelled and
// which were already leaving. The cohort, the level and « Défaillant » are in « Séquence de contact ».
export function TrackingPanel({ prospect, onDirtyChange }: TrackingPanelProps) {
  const queryClient = useQueryClient()
  const { tracking: save } = useProspectMutations()
  // No tracking yet reads as « En séquence ».
  const storedStatus = prospect.tracking?.status ?? 'neutral'
  const [draft, setDraft] = useState<TrackingStatus>(storedStatus)
  const [confirming, setConfirming] = useState<Confirmation | null>(null)
  const [notice, setNotice] = useState<{ text: string; warning: string | null } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const plan = trackingPlan(storedStatus, draft)
  const terminal = storedStatus === 'ignored'
  const blocked = prospect.contactability_status === 'do_not_contact'
  const idPrefix = `contact-tracking-${prospect.id}`
  const offered = TRACKING_STATUSES.filter((status) => status !== 'disqualified' || storedStatus === 'disqualified')

  useEffect(() => {
    onDirtyChange(plan.dirty)
  }, [plan.dirty, onDirtyChange])
  useEffect(
    () => () => {
      onDirtyChange(false)
    },
    [onDirtyChange],
  )

  function change(next: TrackingStatus) {
    setDraft(next)
    setNotice(null)
    setError(null)
  }

  async function submit() {
    setConfirming(null)
    setError(null)
    if (!plan.patch) return
    try {
      const saved = await save.mutateAsync({ id: prospect.id, version: prospect.version, patch: plan.patch })
      setDraft(saved.tracking?.status ?? 'neutral')
      setNotice(savedNotice(saved))
    } catch (caught) {
      const refusal = prospectRefusal(caught)
      if (refusal.conflict) void refreshAfterWrite(queryClient, [prospectKeys.detail(prospect.id)])
      setError(
        refusal.conflict
          ? 'Ce prospect a été modifié entre-temps : la fiche est rechargée, vérifiez puis réessayez.'
          : refusal.message,
      )
    }
  }

  function requestSave() {
    const next = plan.patch?.status
    if (next && CLOSING.includes(next)) setConfirming(confirmationOf(next))
    else void submit()
  }

  const since = prospect.tracking?.status_since
  const hint = terminal
    ? '« Ignoré » est définitif : l’état ne peut plus changer.'
    : draft !== storedStatus
      ? STATE_HINTS[draft]
      : since
        ? `Depuis le ${formatDay(since)}.`
        : undefined

  return (
    <EditorSection title="Suivi de contact">
      {blocked && !terminal && (
        <p className="prospect-editor__note prospect-editor__note--danger">
          <BanIcon size={16} />
          Opposition enregistrée : aucun envoi n’est possible.
        </p>
      )}
      <SelectField
        id={`${idPrefix}-status`}
        label="État commercial"
        value={draft}
        hint={hint}
        disabled={terminal || save.isPending}
        onChange={(event) => {
          change(event.target.value as TrackingStatus)
        }}
      >
        {offered.map((status) => (
          <option key={status} value={status}>
            {TRACKING_LABELS[status]}
          </option>
        ))}
      </SelectField>
      {error && (
        <p className="contact-panel__error" role="alert">
          <AlertIcon size={16} />
          {error}
        </p>
      )}
      <Notice text={notice?.text ?? null} />
      {notice?.warning && (
        <p className="contact-panel__error" role="alert">
          <AlertIcon size={16} />
          {notice.warning}
        </p>
      )}
      {!terminal && (
        <div className="contact-panel__actions">
          {plan.dirty && (
            <Button
              size="sm"
              variant="ghost"
              disabled={save.isPending}
              onClick={() => {
                change(storedStatus)
              }}
            >
              Annuler les modifications
            </Button>
          )}
          <Button
            size="sm"
            variant={plan.dirty ? 'primary' : 'secondary'}
            loading={save.isPending}
            disabled={!plan.dirty}
            onClick={requestSave}
          >
            Enregistrer le suivi
          </Button>
        </div>
      )}
      <ConfirmDialog
        confirmation={confirming}
        busy={save.isPending}
        onConfirm={() => void submit()}
        onClose={() => {
          setConfirming(null)
        }}
      />
    </EditorSection>
  )
}
