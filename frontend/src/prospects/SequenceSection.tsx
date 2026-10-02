import { type ReactNode, useState } from 'react'

import type { Prospect } from '../api/prospects'
import { type Place, type Sequence, useProspectSequences, useSequenceMutations } from '../api/sequences'
import { useProspectMutations } from '../api/prospects'
import { CohortBadge, DueBadge, EmailErrorBadge, LevelBadge, StateBadge } from '../prospection/ContactBadges'
import { formatDay, stepLabel, TRACKING_LABELS } from '../prospection/labels'
import { StatusBadge } from '../ui/Badge'
import { Button } from '../ui/Button'
import { AlertIcon, CheckCircleIcon, MailIcon, MinusCircleIcon, RefreshIcon, SpinnerIcon } from '../ui/icons'
import { EditorSection } from './EditorSection'
import { CohortDialog, ConfirmActionDialog, MarkSentDialog } from './SequenceDialogs'
import {
  END_REASON_LABELS,
  isDue,
  pauseText,
  SEND_SOURCE_LABELS,
  sequenceActions,
  sequenceRefusal,
  validationText,
} from './sequenceModel'
import './sequence.css'

type Dialog = 'cohort' | 'mark_sent' | 'disqualify' | 'resume' | 'email_error' | null

interface SequenceSectionProps {
  prospect: Prospect
  // The editor's form has unsaved changes: these operations do not save them (the dialogs say so).
  pendingChanges?: boolean
  // After a write (or a refusal saying the screen is out of date): the caller reads the prospect again.
  onChanged?: () => void
}

// Séquence de contact (sequences rework D1-D9): the « validation métier » (the cohort), the level reached by the real
// sends, the next send and its due date, the commercial state, and the human actions — change the cohort (a new
// sequence, the counter at zero), « Marquer comme envoyé », « Défaillant », « Reprendre », « Erreur sur le mail ». Each
// is its own audited operation, confirmed first, never the form's save. Below, every sequence the prospect ran.
export function SequenceSection({ prospect, pendingChanges = false, onChanged }: SequenceSectionProps) {
  const query = useProspectSequences(prospect.id)
  const mutations = useSequenceMutations(prospect.id)
  const { tracking } = useProspectMutations()
  const [dialog, setDialog] = useState<Dialog>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const place = query.data?.place
  const state = prospect.tracking?.status ?? 'neutral'

  function open(next: Dialog) {
    setDialog(next)
    setError(null)
    setNotice(null)
    for (const mutation of [mutations.changeCohort, mutations.markSent, mutations.raiseAlert, tracking]) mutation.reset()
  }

  // Runs a write; resolves to whether it succeeded. A refusal is said in the open dialog; a stale screen is read again.
  async function run(write: () => Promise<unknown>, done: string): Promise<boolean> {
    setError(null)
    try {
      await write()
      setDialog(null)
      setNotice(done)
      onChanged?.()
      return true
    } catch (caught) {
      const refusal = sequenceRefusal(caught)
      setError(refusal.message)
      if (refusal.stale) {
        void query.refetch()
        onChanged?.()
      }
      return false
    }
  }

  const head = (
    <EditorSection title="Séquence de contact" tone={place?.email_error ? 'danger' : undefined}>
      {query.isPending && (
        <p className="prospect-editor__note" role="status">
          <SpinnerIcon size={16} className="btn__spinner" />
          Chargement de la séquence…
        </p>
      )}
      {query.isError && (
        <p className="prospect-editor__note prospect-editor__note--danger" role="alert">
          <AlertIcon size={16} />
          Séquence indisponible.
          <Button size="sm" onClick={() => void query.refetch()}>
            Réessayer
          </Button>
        </p>
      )}
      {place && query.data && (
        <SequenceBody
          prospect={prospect}
          place={place}
          sequences={query.data.sequences}
          onAction={open}
          notice={notice}
        />
      )}
    </EditorSection>
  )

  const actions = place ? sequenceActions(place, prospect) : null
  const pending = pendingChanges ? 'Les modifications en cours du formulaire ne sont pas enregistrées par cette action.' : null

  return (
    <>
      {head}
      {place && actions && dialog === 'cohort' && (
        <CohortDialog
          prospectId={prospect.id}
          place={place}
          state={state}
          pending={pending}
          busy={mutations.changeCohort.isPending || mutations.resolveAlert.isPending}
          error={error}
          onClose={() => {
            setDialog(null)
          }}
          onConfirm={(cohortId, resolveEmailError, alertIds) =>
            void run(async () => {
              const change = await mutations.changeCohort.mutateAsync(cohortId)
              if (resolveEmailError && cohortId !== null) {
                for (const id of alertIds) await mutations.resolveAlert.mutateAsync({ id, note: 'Nouvelle adresse et nouvelle cohorte.' })
              }
              return change
            }, cohortId === null ? 'Cohorte retirée : le prospect n’est plus validé.' : 'Nouvelle séquence ouverte : compteur remis à zéro.')
          }
        />
      )}
      {place && actions?.markRank !== null && actions && dialog === 'mark_sent' && place.sequence_id && (
        <MarkSentDialog
          step={place.next_step ?? 'contact'}
          pending={pending}
          busy={mutations.markSent.isPending}
          error={error}
          onClose={() => {
            setDialog(null)
          }}
          onConfirm={(sentAt) =>
            void run(
              () =>
                mutations.markSent.mutateAsync({
                  rank: actions.markRank ?? 0,
                  sequenceId: place.sequence_id ?? '',
                  sentAt,
                }),
              `${stepLabel(place.next_step ?? 'contact')} enregistré comme envoyé.`,
            )
          }
        />
      )}
      {dialog === 'disqualify' && (
        <ConfirmActionDialog
          title="Passer en « Défaillant » ?"
          lines={[
            'Décision humaine : contact à éliminer. Le prospect sort du pipeline actif et des séquences ; il reste dans la base avec son historique.',
            'Les messages non envoyés de la séquence sont annulés.',
            'Pour le reprendre : « Reprendre en séquence » ou un changement de cohorte.',
          ]}
          pending={pending}
          confirmLabel="Confirmer « Défaillant »"
          danger
          busy={tracking.isPending}
          error={error}
          onClose={() => {
            setDialog(null)
          }}
          onConfirm={() =>
            void run(
              () => tracking.mutateAsync({ id: prospect.id, version: prospect.version, patch: { status: 'disqualified' } }),
              'Prospect passé en « Défaillant ».',
            )
          }
        />
      )}
      {dialog === 'resume' && (
        <ConfirmActionDialog
          title="Reprendre en séquence ?"
          lines={[
            'L’état repasse « En séquence » : la séquence actuelle reprend là où elle s’était arrêtée (le niveau est conservé).',
            'Pour repartir de zéro avec une nouvelle séquence, changez plutôt de cohorte.',
          ]}
          pending={pending}
          confirmLabel="Reprendre en séquence"
          busy={tracking.isPending}
          error={error}
          onClose={() => {
            setDialog(null)
          }}
          onConfirm={() =>
            void run(
              () => tracking.mutateAsync({ id: prospect.id, version: prospect.version, patch: { status: 'neutral' } }),
              'Prospect repris en séquence.',
            )
          }
        />
      )}
      {dialog === 'email_error' && (
        <ConfirmActionDialog
          title="Signaler une erreur sur le mail ?"
          lines={[
            'Le prospect garde sa cohorte, son état et son historique ; il sort des actions automatiques (plus rien n’est dû) et apparaît dans « Erreur sur le mail ».',
            'Il ne devient ni « Défaillant » ni invalide.',
            'Pour le reprendre : enregistrez une nouvelle adresse e-mail, puis changez de cohorte (nouvelle Sxx).',
          ]}
          pending={pending}
          note
          confirmLabel="Signaler l’erreur sur le mail"
          busy={mutations.raiseAlert.isPending}
          error={error}
          onClose={() => {
            setDialog(null)
          }}
          onConfirm={(note) =>
            void run(
              () => mutations.raiseAlert.mutateAsync({ type: 'email_error', note }),
              'Erreur sur le mail signalée : le prospect est sorti des actions automatiques.',
            )
          }
        />
      )}
    </>
  )
}

interface SequenceBodyProps {
  prospect: Prospect
  place: Place
  sequences: Sequence[]
  onAction: (dialog: Dialog) => void
  notice: string | null
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="sequence-facts__item">
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  )
}

function SequenceBody({ prospect, place, sequences, onAction, notice }: SequenceBodyProps) {
  const state = prospect.tracking?.status ?? 'neutral'
  const actions = sequenceActions(place, prospect)
  const paused = pauseText(place, state)
  const inCampaign = place.cohort !== null && !place.cohort.out_of_campaign
  return (
    <>
      {place.email_error && (
        <div className="sequence-banner" role="note">
          <MailIcon size={18} />
          <p>
            <strong>Erreur sur le mail.</strong> Ce prospect est sorti des actions automatiques : rien n’est dû tant que
            l’alerte est ouverte. Il garde sa cohorte, son état et son historique. Pour le reprendre : enregistrez une
            nouvelle adresse e-mail, puis changez de cohorte (nouvelle Sxx).
          </p>
        </div>
      )}
      <dl className="sequence-facts">
        <Fact label="Validation">
          <span className="sequence-facts__line">
            <CohortBadge code={place.cohort?.code ?? null} startsOn={place.cohort?.starts_on ?? null} />
            {validationText(place.cohort)}
          </span>
          {place.cohort?.needs_review && (
            <span className="sequence-facts__hint">Date reprise de l’ancien suivi : à confirmer dans Paramètres.</span>
          )}
        </Fact>
        <Fact label="Niveau">
          {inCampaign && place.level ? (
            <span className="sequence-facts__line">
              <LevelBadge level={place.level} />
              <span className="sequence-facts__hint">
                {place.sent_count} envoi{place.sent_count > 1 ? 's' : ''} · relances jusqu’à R{place.max_follow_ups}
              </span>
            </span>
          ) : (
            <span className="sequence-facts__hint">—</span>
          )}
        </Fact>
        <Fact label="Prochain envoi">
          {place.next_due_on && place.next_step ? (
            <span className="sequence-facts__line">
              {stepLabel(place.next_step)} à envoyer le {formatDay(place.next_due_on)}
              {isDue(place, prospect.today) && <DueBadge />}
            </span>
          ) : (
            <span className="sequence-facts__hint">{paused ?? '—'}</span>
          )}
        </Fact>
        <Fact label="État commercial">
          <span className="sequence-facts__line">
            {state === 'neutral' ? TRACKING_LABELS.neutral : <StateBadge status={state} />}
            {place.email_error && <EmailErrorBadge />}
          </span>
        </Fact>
      </dl>
      {actions.cohortBlocked && (
        <p className="prospect-editor__note">
          <MinusCircleIcon size={16} />
          {actions.cohortBlocked}
        </p>
      )}
      <div className="sequence-actions">
        {actions.markRank !== null && (
          <Button
            size="sm"
            variant="primary"
            icon={CheckCircleIcon}
            onClick={() => {
              onAction('mark_sent')
            }}
          >
            Marquer {stepLabel(place.next_step ?? 'contact')} comme envoyé…
          </Button>
        )}
        <Button
          size="sm"
          icon={RefreshIcon}
          disabled={actions.cohortBlocked !== null}
          onClick={() => {
            onAction('cohort')
          }}
        >
          {place.cohort ? 'Changer de cohorte…' : 'Valider dans une cohorte…'}
        </Button>
        {actions.resume && (
          <Button
            size="sm"
            onClick={() => {
              onAction('resume')
            }}
          >
            Reprendre en séquence…
          </Button>
        )}
        {actions.disqualify && (
          <Button
            size="sm"
            variant="ghost"
            icon={MinusCircleIcon}
            onClick={() => {
              onAction('disqualify')
            }}
          >
            Défaillant…
          </Button>
        )}
        {actions.emailError && (
          <Button
            size="sm"
            variant="ghost"
            icon={MailIcon}
            onClick={() => {
              onAction('email_error')
            }}
          >
            Erreur sur le mail…
          </Button>
        )}
      </div>
      <p className="visually-hidden" role="status">
        {notice ?? ''}
      </p>
      {notice && (
        <p className="sequence-notice" aria-hidden="true">
          <CheckCircleIcon size={16} />
          {notice}
        </p>
      )}
      <SequenceHistory sequences={sequences} />
    </>
  )
}

// Every sequence the prospect ran, current first: its cohort, dates, how it ended and its messages (sends with their
// source; drafts and cancelled ones too, they are part of what happened).
function SequenceHistory({ sequences }: { sequences: Sequence[] }) {
  if (sequences.length === 0) return <p className="sequence-facts__hint">Aucune séquence pour l’instant.</p>
  return (
    <div className="sequence-history">
      <h4 className="sequence-history__title">Historique des séquences</h4>
      <ol className="sequence-history__list">
        {sequences.map((sequence) => (
          <li key={sequence.id} className="sequence-history__item" data-current={sequence.is_current ? '' : undefined}>
            <div className="sequence-history__head">
              <CohortBadge code={sequence.cohort.code} startsOn={sequence.cohort.starts_on} />
              <span>
                Ouverte le {formatDay(sequence.opened_at)}
                {sequence.closed_at && ` · close le ${formatDay(sequence.closed_at)}`}
              </span>
              {sequence.end_reason ? (
                <StatusBadge tone="neutral">{END_REASON_LABELS[sequence.end_reason]}</StatusBadge>
              ) : (
                sequence.is_current && <StatusBadge tone="info">En cours</StatusBadge>
              )}
            </div>
            {sequence.messages.length === 0 ? (
              <p className="sequence-facts__hint">Aucun envoi.</p>
            ) : (
              <ul className="sequence-history__sends" aria-label={`Messages de la séquence ${sequence.cohort.code}`}>
                {sequence.messages.map((message) => (
                  <li key={message.message_id}>
                    <strong>{message.step_label}</strong>
                    {message.status === 'sent' ? (
                      <span>
                        envoyé{message.sent_at ? ` le ${formatDay(message.sent_at)}` : ''}
                        {message.sent_source && ` · ${SEND_SOURCE_LABELS[message.sent_source]}`}
                      </span>
                    ) : (
                      <span className="sequence-facts__hint">{MESSAGE_STATUS[message.status]}</span>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </li>
        ))}
      </ol>
    </div>
  )
}

const MESSAGE_STATUS = {
  draft: 'brouillon, non envoyé',
  validated: 'validé, non envoyé',
  scheduled: 'programmé, non envoyé',
  sent: 'envoyé',
  cancelled: 'annulé, non envoyé',
} as const
