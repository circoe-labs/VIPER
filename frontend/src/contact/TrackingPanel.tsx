import { useQueryClient } from '@tanstack/react-query'
import { useEffect, useState } from 'react'

import { TRACKING_STATUSES, type TrackingStatus } from '../api/prospection'
import { refreshAfterWrite } from '../api/refresh'
import { type Prospect, prospectKeys, type TrackingPatch, useProspectMutations } from '../api/prospects'
import { type IsoWeek, parseIsoWeek, sameWeek, weekBadgeLabel } from '../lib/isoWeek'
import { formatDay, TRACKING_LABELS } from '../prospection/labels'
import { EditorSection } from '../prospects/EditorSection'
import { prospectRefusal } from '../prospects/messages'
import { cadenceSuggestion, WeekPlanner } from '../prospects/WeekPlanner'
import { Button } from '../ui/Button'
import { SelectField } from '../ui/fields'
import { AlertIcon, BanIcon, InfoIcon } from '../ui/icons'
import { type Confirmation, ConfirmDialog } from './ConfirmDialog'
import { Notice } from './Notice'
import '../prospects/prospects.css'

// States that close the mail sequence (decision 29: their unsent messages are cancelled) and those that clear the
// stored week when no week is sent with them (the PATCH rule, doc/features/prospect-editor.md).
const CLOSING: readonly TrackingStatus[] = ['response_received', 'appointment_obtained', 'ignored']
const CLEARS_WEEK: readonly TrackingStatus[] = ['response_received', 'appointment_obtained', 'failure', 'ignored']

const STATE_HINTS: Partial<Record<TrackingStatus, string>> = {
  response_received: 'Les messages non envoyés seront annulés.',
  appointment_obtained: 'Fin de la séquence : les messages non envoyés seront annulés.',
  failure: 'Séquence close sans réponse. Ce n’est pas une opposition.',
  ignored: 'Définitif : le prospect passe en « Ne pas contacter » et sort de Contact.',
}

interface TrackingDraft {
  status: TrackingStatus
  // undefined: the week is not touched.
  week: IsoWeek | null | undefined
}

export interface TrackingPlan {
  // What the planner shows.
  shownWeek: IsoWeek | null
  patch: TrackingPatch
  dirty: boolean
}

// The PATCH of a choice: the state when it changed, the week only when a person chose one (an untouched week goes with
// a week-clearing state: the server clears it, and the planner already shows it cleared). `ignored` never carries a
// week (refused by the server).
export function trackingPlan(stored: { status: TrackingStatus; week: IsoWeek | null }, draft: TrackingDraft): TrackingPlan {
  const stateChanged = draft.status !== stored.status
  const cleared = stateChanged && CLEARS_WEEK.includes(draft.status)
  const shownWeek = draft.status === 'ignored' ? null : draft.week !== undefined ? draft.week : cleared ? null : stored.week
  const patch: TrackingPatch = {}
  if (stateChanged) patch.status = draft.status
  if (draft.week !== undefined && draft.status !== 'ignored' && !sameWeek(draft.week, stored.week)) {
    patch.next_action_week = draft.week
  } else if (draft.week !== undefined && draft.status !== 'ignored' && cleared && draft.week !== null) {
    // The same week kept on purpose with a week-clearing state: sent explicitly, so the server keeps it.
    patch.next_action_week = draft.week
  }
  return { shownWeek, patch, dirty: Object.keys(patch).length > 0 }
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

function confirmationOf(prospect: Prospect, status: TrackingStatus, week: IsoWeek | null): Confirmation {
  const label = TRACKING_LABELS[status]
  const lines = [
    'Les messages non envoyés de la séquence (Contact, R1, R2) seront annulés, s’il y en a. Les messages déjà envoyés restent consultables.',
  ]
  const stored = parseIsoWeek(prospect.tracking?.planned_contact_week)
  if (stored && !week) lines.push(`La prochaine semaine (${weekBadgeLabel(stored)} ${String(stored.year)}) sera retirée.`)
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

// Suivi de contact in the workbench: the state chosen by hand (decision 10) and the next-action week (S2's planner),
// saved together through `PATCH /prospects/{id}/tracking` — never by a mail action. A sequence-closing state is
// confirmed first; the answer says how many unsent messages it cancelled and which were already leaving.
export function TrackingPanel({ prospect, onDirtyChange }: TrackingPanelProps) {
  const queryClient = useQueryClient()
  const { tracking: save } = useProspectMutations()
  // No tracking yet reads as « Aucun état »: choosing a week alone creates it (at `neutral`).
  const storedStatus = prospect.tracking?.status ?? 'neutral'
  const stored = { status: storedStatus, week: parseIsoWeek(prospect.tracking?.planned_contact_week) }
  const [draft, setDraft] = useState<TrackingDraft>({ status: storedStatus, week: undefined })
  const [confirming, setConfirming] = useState<Confirmation | null>(null)
  const [notice, setNotice] = useState<{ text: string; warning: string | null } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const plan = trackingPlan(stored, draft)
  const terminal = storedStatus === 'ignored'
  const blocked = prospect.contactability_status === 'do_not_contact'
  const idPrefix = `contact-tracking-${prospect.id}`

  useEffect(() => {
    onDirtyChange(plan.dirty)
  }, [plan.dirty, onDirtyChange])
  useEffect(
    () => () => {
      onDirtyChange(false)
    },
    [onDirtyChange],
  )

  function change(next: Partial<TrackingDraft>) {
    setDraft((current) => ({ ...current, ...next }))
    setNotice(null)
    setError(null)
  }

  async function submit() {
    setConfirming(null)
    setError(null)
    try {
      const saved = await save.mutateAsync({ id: prospect.id, version: prospect.version, patch: plan.patch })
      setDraft({ status: saved.tracking?.status ?? 'neutral', week: undefined })
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
    const next = plan.patch.status
    if (next && CLOSING.includes(next)) setConfirming(confirmationOf(prospect, next, plan.shownWeek))
    else void submit()
  }

  const since = prospect.tracking?.status_since
  const hint = terminal
    ? '« Ignoré » est définitif : l’état ne peut plus changer.'
    : draft.status !== storedStatus
      ? STATE_HINTS[draft.status]
      : since
        ? `Depuis le ${formatDay(since)}.`
        : undefined

  return (
    <EditorSection title="Suivi de contact">
      {blocked && !terminal && (
        <p className="prospect-editor__note prospect-editor__note--danger">
          <BanIcon size={16} />
          Opposition enregistrée : ne planifiez pas de contact.
        </p>
      )}
      <SelectField
        id={`${idPrefix}-status`}
        label="État"
        value={draft.status}
        hint={hint}
        disabled={terminal || save.isPending}
        onChange={(event) => {
          change({ status: event.target.value as TrackingStatus })
        }}
      >
        {TRACKING_STATUSES.map((status) => (
          <option key={status} value={status}>
            {TRACKING_LABELS[status]}
          </option>
        ))}
      </SelectField>
      {draft.status === 'ignored' ? (
        <p className="prospect-editor__note">
          <InfoIcon size={16} />
          Prospect ignoré : aucune prochaine action ne peut être planifiée.
        </p>
      ) : (
        <WeekPlanner
          idPrefix={idPrefix}
          value={plan.shownWeek}
          today={prospect.today}
          suggestion={cadenceSuggestion(prospect.tracking, draft.status)}
          disabled={save.isPending}
          onChange={(week) => {
            change({ week })
          }}
        />
      )}
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
                change({ status: storedStatus, week: undefined })
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
