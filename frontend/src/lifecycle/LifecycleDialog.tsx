import { useState } from 'react'

import { ApiError } from '../api/client'
import { useCompany } from '../api/companies'
import { type Lifecycle, type LifecycleChanged, type LifecycleSubject, useLifecycleChange } from '../api/lifecycle'
import { useProspect } from '../api/prospects'
import { useElapsed } from '../lib/useElapsed'
import { Button } from '../ui/Button'
import { Modal } from '../ui/Dialog'
import { TextAreaField } from '../ui/fields'
import { AlertIcon, CheckCircleIcon, SpinnerIcon } from '../ui/icons'
import { InfoTip } from '../ui/InfoTip'
import { LifecycleSummary } from './LifecycleSummary'
import { statusChoices } from './model'
import './lifecycle.css'

export interface LifecycleDialogProps {
  subject: LifecycleSubject
  // `archive`: the archive (or unarchive) choice is already selected.
  intent: 'status' | 'archive'
  onClose: () => void
  // After a change, e.g. so an open editor reads the record again.
  onChanged?: () => void
}

// « Changer de statut » and « Archiver », for a person or a company, from a sheet or a list row: what keeps the record
// out of prospecting today, one choice, its reason, and what the change did. Nothing is deleted.
export function LifecycleDialog(props: LifecycleDialogProps) {
  return props.subject.type === 'prospect' ? <ProspectDialog {...props} /> : <CompanyDialog {...props} />
}

function ProspectDialog(props: LifecycleDialogProps) {
  const loaded = useProspect(props.subject.id)
  return <Content {...props} state={loaded.data?.lifecycle} departed={loaded.data?.activity_status === 'inactive'} failed={loaded.isError} onRetry={() => void loaded.refetch()} />
}

function CompanyDialog(props: LifecycleDialogProps) {
  const loaded = useCompany(props.subject.id)
  return <Content {...props} state={loaded.data?.lifecycle} departed={false} failed={loaded.isError} onRetry={() => void loaded.refetch()} />
}

interface ContentProps extends LifecycleDialogProps {
  state: Lifecycle | undefined
  departed: boolean
  failed: boolean
  onRetry: () => void
}

function failure(error: unknown): string {
  if (error instanceof ApiError && error.status === 404) return 'Cette fiche n’existe plus.'
  if (error instanceof ApiError && error.status === 403) return 'Seule une personne connectée peut faire cette action.'
  if (error instanceof ApiError) return `Le serveur a refusé (HTTP ${String(error.status)}). Rien n’a changé.`
  return 'Pas de réponse du serveur : rouvrez la fiche pour vérifier avant de recommencer.'
}

function done(result: LifecycleChanged): string {
  if (!result.changed) return 'Déjà à jour : rien à changer.'
  const parts = ['Enregistré.']
  const cancelled = result.cancelled_messages
  if (cancelled) parts.push(cancelled > 1 ? `${String(cancelled)} messages non envoyés annulés.` : '1 message non envoyé annulé.')
  if (result.in_flight_messages) parts.push(`${String(result.in_flight_messages)} message en cours d’envoi : il peut encore partir, vérifiez-le.`)
  return parts.join(' ')
}

function Content({ subject, intent, onClose, onChanged, state, departed, failed, onRetry }: ContentProps) {
  const change = useLifecycleChange(subject)
  const [selected, setSelected] = useState<string | null>(null)
  const [reason, setReason] = useState('')
  const [result, setResult] = useState<LifecycleChanged | null>(null)
  const seconds = useElapsed(change.isPending ? change.submittedAt : null)
  const choices = state ? statusChoices(state, subject.type, departed) : []
  const preset = intent === 'archive' ? choices.find((item) => item.action === 'archive' || item.action === 'unarchive') : undefined
  const current = choices.find((item) => item.id === (selected ?? preset?.id))
  const ready = current !== undefined && (!current.reasonRequired || reason.trim() !== '')
  const blocked = state !== undefined && (state.block !== null || state.holds.length > 0)

  function submit() {
    if (!current || !ready || change.isPending) return
    change.mutate(
      { action: current.action, reason: reason.trim() || null, departure_reason: current.departure_reason },
      {
        onSuccess: (answer) => {
          setResult(answer)
          onChanged?.()
        },
        onError: (error) => {
          console.error('lifecycle.change_failed', subject.type, current.action, error)
        },
      },
    )
  }

  return (
    <Modal
      open
      title={`${intent === 'archive' ? 'Archiver' : 'Statut de prospection'} : ${subject.name}`}
      onClose={() => {
        if (!change.isPending) onClose()
      }}
      footer={
        result ? (
          <Button variant="primary" onClick={onClose}>Fermer</Button>
        ) : (
          <>
            {change.isPending && <span role="status" className="lifecycle-dialog__saving"><SpinnerIcon size={16} className="btn__spinner" />Enregistrement… {seconds >= 2 ? `${String(seconds)} s` : ''}</span>}
            <Button onClick={onClose} disabled={change.isPending}>Annuler</Button>
            <Button variant="primary" onClick={submit} disabled={!ready} loading={change.isPending}>Confirmer</Button>
          </>
        )
      }
    >
      {!state && !failed && <p role="status" className="lifecycle-dialog__saving"><SpinnerIcon size={16} className="btn__spinner" />Chargement…</p>}
      {!state && failed && <p role="alert" className="lifecycle-dialog__error"><AlertIcon size={16} />Fiche indisponible.<Button size="sm" onClick={onRetry}>Réessayer</Button></p>}
      {state && result && (
        <div className="lifecycle-dialog">
          <p role="status" className="lifecycle-dialog__done"><CheckCircleIcon size={18} />{done(result)}</p>
          <LifecycleSummary state={result.lifecycle} />
        </div>
      )}
      {state && !result && (
        <div className="lifecycle-dialog">
          {blocked && <LifecycleSummary state={state} />}
          <fieldset className="lifecycle-dialog__choices" disabled={change.isPending}>
            <legend>
              Action
              <InfoTip label="Ce que change cette action">
                Rien n’est supprimé et tout est réversible. Les messages validés ou programmés sont annulés (à rouvrir et revalider ensuite). Une opposition « Ne pas contacter » n’est jamais levée ici.
              </InfoTip>
            </legend>
            {choices.map((item) => (
              <label key={item.id} className="lifecycle-dialog__choice">
                <input type="radio" name="lifecycle-choice" checked={current?.id === item.id} onChange={() => { setSelected(item.id) }} />
                {item.label}
              </label>
            ))}
          </fieldset>
          {current && (
            <TextAreaField label={current.reasonLabel} required={current.reasonRequired} rows={2} maxLength={1000} value={reason} disabled={change.isPending} onChange={(event) => { setReason(event.target.value) }} />
          )}
          {change.isError && <p role="alert" className="lifecycle-dialog__error"><AlertIcon size={16} />{failure(change.error)}</p>}
        </div>
      )}
    </Modal>
  )
}
