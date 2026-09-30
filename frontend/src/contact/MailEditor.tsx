import { type ReactNode, useEffect, useRef, useState } from 'react'

import type { Message, MessageSequence, MessageStatus, MessageStep, useMessageMutations } from '../api/contact'
import { Button } from '../ui/Button'
import { TextAreaField, TextField } from '../ui/fields'
import { AlertIcon, CalendarIcon, CheckIcon, CloseIcon, LockIcon, RefreshIcon, SaveIcon, UndoIcon } from '../ui/icons'
import { type Confirmation, ConfirmDialog } from './ConfirmDialog'
import { formatDateTime, STEP_LABELS } from './labels'
import {
  ADDRESS_MAX_LENGTH,
  BODY_MAX_LENGTH,
  contentOf,
  isDirty,
  localDay,
  localErrors,
  localZoneLabel,
  type MailActions,
  type MailForm,
  orderWarning,
  RECIPIENTS_MAX_LENGTH,
  scheduleToIso,
  statusLine,
} from './mailModel'
import { Notice } from './Notice'
import { type MailField, type MessageRefusal, messageRefusal } from './messages'

type Mutations = ReturnType<typeof useMessageMutations>

interface MailEditorProps {
  step: MessageStep
  sequence: MessageSequence
  message: Message | null
  actions: MailActions
  // The saved version as a form, and the form shown (the saved one while nothing is edited).
  saved: MailForm
  form: MailForm
  onForm: (form: MailForm | undefined) => void
  mutations: Mutations
  // Reads the sequence again (after a refusal saying the server's message differs).
  onReload: () => void
  // The send moment typed for this step (kept by the sequence across tab switches).
  when: SendMoment
  onWhen: (when: SendMoment) => void
  // Slot of the action bar's left side, for the AI drafting of Slice S5 (« Générer avec l'IA »). Empty until then.
  assist?: ReactNode
}

type Pending = 'validate' | 'schedule' | 'cancel'

export interface SendMoment {
  date: string
  time: string
}

const FIELD_LABELS: Record<MailField, string> = { from: 'De', to: 'À', cc: 'Cc', bcc: 'Cci', subject: 'Objet', body: 'Corps' }

// One step's message, laid out like a mailbox's compose window (De, À, Cc, Cci, Objet, Corps), with the actions of its
// status: create / save (never validates), validate…, date + time then schedule…, unschedule, cancel…, reopen. A sent
// message is read-only; a closed sequence locks the editor with its reason.
export function MailEditor({
  step,
  sequence,
  message,
  actions,
  saved,
  form,
  onForm,
  mutations,
  onReload,
  when,
  onWhen,
  assist,
}: MailEditorProps) {
  const [refusal, setRefusal] = useState<MessageRefusal | null>(null)
  // The outcome of the last action, kept while the message stays in the status that action left it in (a state
  // change elsewhere that cancels the message makes it stale).
  const [notice, setNotice] = useState<{ text: string; status: MessageStatus } | null>(null)
  const [pending, setPending] = useState<Pending | null>(null)
  const { date, time } = when
  // A confirmed action removes its own button (« Valider… » once validated…): the focus goes to the status sentence,
  // which reads the new status, once the confirmation has closed.
  const statusRef = useRef<HTMLParagraphElement>(null)
  const focusStatus = useRef(false)
  useEffect(() => {
    if (pending !== null || !focusStatus.current) return
    focusStatus.current = false
    statusRef.current?.focus()
  }, [pending])
  const [scheduleError, setScheduleError] = useState<string | null>(null)
  const label = STEP_LABELS[step]
  const dirty = actions.editable && isDirty(form, saved)
  const busy = mutations.save.isPending || mutations.act.isPending || mutations.schedule.isPending
  const local = actions.editable ? localErrors(form) : {}
  const status = message?.status ?? null
  const fieldId = (field: string) => `contact-mail-${step}-${field}`

  function edit(patch: Partial<MailForm>) {
    onForm({ ...form, ...patch })
    setNotice(null)
    setRefusal(null)
  }

  function failed(caught: unknown) {
    const view = messageRefusal(caught)
    setRefusal(view)
    if (view.reload) onReload()
  }

  async function saveForm() {
    setNotice(null)
    setRefusal(null)
    try {
      const result = await mutations.save.mutateAsync({ step, content: contentOf(form, message?.revision ?? null) })
      onForm(undefined)
      setNotice({
        status: result.message.status,
        text: result.created
          ? `Brouillon ${label} créé.`
          : !result.changed
            ? 'Aucune modification à enregistrer.'
            : result.unvalidated
              ? `Message ${label} enregistré et repassé en Brouillon : à revalider.`
              : `Message ${label} enregistré.`,
      })
    } catch (caught) {
      failed(caught)
    }
  }

  async function act(action: 'validate' | 'unschedule' | 'cancel' | 'reopen') {
    if (!message) return
    setNotice(null)
    setRefusal(null)
    try {
      const result = await mutations.act.mutateAsync({ step, action, revision: message.revision })
      focusStatus.current = action !== 'unschedule'
      setNotice({
        status: result.message.status,
        text: {
          validate: `Message ${label} validé : il peut maintenant être programmé.`,
          unschedule: `Programmation du message ${label} retirée : il reste validé.`,
          cancel: `Message ${label} annulé : il ne partira pas.`,
          reopen: `Message ${label} rouvert en Brouillon : à relire puis revalider.`,
        }[action],
      })
    } catch (caught) {
      failed(caught)
    } finally {
      setPending(null)
    }
  }

  async function schedule(iso: string) {
    if (!message) return
    setNotice(null)
    setRefusal(null)
    try {
      const result = await mutations.schedule.mutateAsync({ step, revision: message.revision, at: iso })
      onWhen({ date: '', time: '' })
      focusStatus.current = true
      setNotice({
        status: result.message.status,
        text: `Message ${label} programmé pour le ${formatDateTime(result.message.scheduled_at ?? iso)}.`,
      })
    } catch (caught) {
      failed(caught)
    } finally {
      setPending(null)
    }
  }

  const parsed = scheduleToIso(date, time, new Date())
  // The offset shown is the chosen day's (summer / winter time), today's until a day is chosen.
  const zoneAt = parsed.ok ? parsed.at : /^\d{4}-\d{2}-\d{2}$/.test(date) ? new Date(`${date}T12:00:00`) : new Date()
  const warning = actions.schedule ? orderWarning(step, sequence, parsed.ok ? parsed.at : null) : null

  function confirmation(): Confirmation | null {
    if (pending === 'validate') {
      return {
        title: `Valider le message ${label} ?`,
        lines: [
          'Vous confirmez avoir relu les destinataires, l’objet et le corps. Rien n’est envoyé maintenant : le message pourra ensuite être programmé.',
          'Toute modification ultérieure le repassera en Brouillon et demandera une nouvelle validation.',
        ],
        confirmLabel: 'Valider le message',
      }
    }
    if (pending === 'schedule' && parsed.ok) {
      return {
        title: `Programmer le message ${label} ?`,
        lines: [
          `Envoi prévu le ${formatDateTime(parsed.iso)} (${localZoneLabel(parsed.at)}).`,
          'L’envoi automatique n’est pas encore actif dans VIPER : la date est enregistrée, mais aucun mail ne part tant qu’il ne l’est pas. Vous pourrez déprogrammer tant que le message n’est pas envoyé.',
        ],
        warning,
        confirmLabel: 'Programmer l’envoi',
      }
    }
    if (pending === 'cancel') {
      return {
        title: `Annuler le message ${label} ?`,
        lines: [
          'Il ne partira pas. Il reste consultable et pourra être rouvert tant que la séquence du prospect reste ouverte.',
        ],
        confirmLabel: 'Annuler le message',
        danger: true,
      }
    }
    return null
  }

  function requestSchedule() {
    setScheduleError(null)
    if (!parsed.ok) {
      setScheduleError(parsed.error)
      return
    }
    setPending('schedule')
  }

  function onConfirm() {
    if (pending === 'schedule' && parsed.ok) void schedule(parsed.iso)
    else if (pending === 'validate' || pending === 'cancel') void act(pending)
  }

  const errorOf = (field: MailField) => refusal?.fields[field] ?? local[field]
  const readOnly = !actions.editable || busy
  const hasLocalErrors = Object.keys(local).length > 0
  const waitSave = dirty ? 'Enregistrez d’abord les modifications.' : undefined

  return (
    <div className="contact-mail">
      <p ref={statusRef} tabIndex={-1} className="contact-mail__status">
        {statusLine(message, sequence.sequence.closed || sequence.sequence.do_not_contact)}
      </p>

      {actions.lock && (
        <p className="contact-mail__lock">
          <LockIcon size={16} />
          {actions.lock}
        </p>
      )}

      {dirty && (status === 'validated' || status === 'scheduled') && (
        <p className="contact-mail__banner" role="note">
          <AlertIcon size={16} />
          {status === 'scheduled'
            ? 'Ce message est programmé : l’enregistrer retire la programmation et le repasse en Brouillon. Il faudra le revalider puis le reprogrammer.'
            : 'Ce message est validé : l’enregistrer le repasse en Brouillon. Il faudra le revalider.'}
        </p>
      )}

      <div className="contact-mail__fields">
        <TextField
          id={fieldId('from')}
          label={FIELD_LABELS.from}
          type="email"
          maxLength={ADDRESS_MAX_LENGTH}
          value={form.from}
          readOnly={readOnly}
          placeholder={actions.editable ? 'prospection@exemple.fr' : undefined}
          error={errorOf('from')}
          onChange={(event) => {
            edit({ from: event.target.value })
          }}
        />
        <TextField
          id={fieldId('to')}
          label={FIELD_LABELS.to}
          value={form.to}
          maxLength={RECIPIENTS_MAX_LENGTH}
          readOnly={readOnly}
          error={errorOf('to')}
          onChange={(event) => {
            edit({ to: event.target.value })
          }}
        />
        <div className="contact-mail__pair">
          <TextField
            id={fieldId('cc')}
            label={FIELD_LABELS.cc}
            value={form.cc}
            maxLength={RECIPIENTS_MAX_LENGTH}
            readOnly={readOnly}
            error={errorOf('cc')}
            onChange={(event) => {
              edit({ cc: event.target.value })
            }}
          />
          <TextField
            id={fieldId('bcc')}
            label={FIELD_LABELS.bcc}
            value={form.bcc}
            maxLength={RECIPIENTS_MAX_LENGTH}
            readOnly={readOnly}
            error={errorOf('bcc')}
            onChange={(event) => {
              edit({ bcc: event.target.value })
            }}
          />
        </div>
        {actions.editable && (
          <p className="contact-mail__hint">Plusieurs adresses dans un champ : séparez-les par une virgule.</p>
        )}
        <TextField
          id={fieldId('subject')}
          label={FIELD_LABELS.subject}
          value={form.subject}
          readOnly={readOnly}
          maxLength={998}
          error={errorOf('subject')}
          onChange={(event) => {
            edit({ subject: event.target.value })
          }}
        />
        <TextAreaField
          id={fieldId('body')}
          label={FIELD_LABELS.body}
          className="contact-mail__body"
          value={form.body}
          maxLength={BODY_MAX_LENGTH}
          readOnly={readOnly}
          rows={14}
          error={errorOf('body')}
          onChange={(event) => {
            edit({ body: event.target.value })
          }}
        />
      </div>

      {actions.schedule && (
        <fieldset className="contact-mail__schedule" disabled={busy}>
          <legend className="contact-mail__legend">Programmer l’envoi</legend>
          <div className="contact-mail__when">
            <TextField
              id={fieldId('date')}
              label="Date d’envoi"
              type="date"
              min={localDay(new Date())}
              value={date}
              onChange={(event) => {
                onWhen({ date: event.target.value, time })
                setScheduleError(null)
              }}
            />
            <TextField
              id={fieldId('time')}
              label="Heure"
              type="time"
              value={time}
              onChange={(event) => {
                onWhen({ date, time: event.target.value })
                setScheduleError(null)
              }}
            />
          </div>
          <p className="contact-mail__hint">Heure locale ({localZoneLabel(zoneAt)}). Aucune heure n’est proposée par défaut.</p>
          {(scheduleError ?? refusal?.fields.schedule) && (
            <p className="field__error" role="alert">
              <AlertIcon size={16} />
              {scheduleError ?? refusal?.fields.schedule}
            </p>
          )}
          {warning && (
            <p className="field__warning">
              <AlertIcon size={16} />
              {warning}
            </p>
          )}
        </fieldset>
      )}

      {refusal && (
        <div className="contact-panel__error" role="alert">
          <AlertIcon size={16} />
          <span>{refusal.message}</span>
          {refusal.conflict && dirty && (
            <Button
              size="sm"
              onClick={() => {
                onForm(undefined)
                setRefusal(null)
              }}
            >
              Voir la version enregistrée
            </Button>
          )}
        </div>
      )}
      <Notice text={notice && notice.status === status ? notice.text : null} />

      {(assist ?? Object.values(actions).some((value) => value === true)) && (
        <div className="contact-mail__actions">
          <div className="contact-mail__assist">{assist}</div>
          <div className="contact-mail__buttons">
            {actions.cancel && (
              <Button
                variant="ghost"
                icon={CloseIcon}
                disabled={busy}
                onClick={() => {
                  setPending('cancel')
                }}
              >
                Annuler le message…
              </Button>
            )}
            {dirty && (
              <Button
                variant="ghost"
                icon={UndoIcon}
                disabled={busy}
                onClick={() => {
                  onForm(undefined)
                  setRefusal(null)
                }}
              >
                Abandonner les modifications
              </Button>
            )}
            {actions.save && (
              <Button
                variant={dirty || actions.save === 'create' ? 'primary' : 'secondary'}
                icon={SaveIcon}
                loading={mutations.save.isPending}
                disabled={(actions.save === 'save' && !dirty) || hasLocalErrors}
                onClick={() => void saveForm()}
              >
                {actions.save === 'create' ? 'Créer le brouillon' : 'Enregistrer'}
              </Button>
            )}
            {actions.validate && (
              <Button
                variant={dirty ? 'secondary' : 'primary'}
                icon={CheckIcon}
                disabled={busy || dirty}
                title={waitSave}
                onClick={() => {
                  setPending('validate')
                }}
              >
                Valider…
              </Button>
            )}
            {actions.schedule && (
              <Button
                variant={dirty ? 'secondary' : 'primary'}
                icon={CalendarIcon}
                disabled={busy || dirty}
                title={waitSave}
                onClick={requestSchedule}
              >
                Programmer…
              </Button>
            )}
            {actions.unschedule && (
              <Button
                icon={UndoIcon}
                loading={mutations.act.isPending && mutations.act.variables.action === 'unschedule'}
                disabled={busy || dirty}
                title={waitSave}
                onClick={() => void act('unschedule')}
              >
                Déprogrammer
              </Button>
            )}
            {actions.reopen && (
              <Button
                variant="primary"
                icon={RefreshIcon}
                loading={mutations.act.isPending && mutations.act.variables.action === 'reopen'}
                disabled={busy}
                onClick={() => void act('reopen')}
              >
                Rouvrir
              </Button>
            )}
          </div>
        </div>
      )}

      <ConfirmDialog
        confirmation={confirmation()}
        busy={busy}
        onConfirm={onConfirm}
        onClose={() => {
          setPending(null)
        }}
      />
    </div>
  )
}
