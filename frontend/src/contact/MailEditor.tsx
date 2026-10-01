import { useEffect, useRef, useState } from 'react'

import type { Message, MessageSequence, MessageStatus, MessageStep, useMessageMutations } from '../api/contact'
import { Button } from '../ui/Button'
import { TextAreaField, TextField } from '../ui/fields'
import {
  AlertIcon,
  CalendarIcon,
  CheckCircleIcon,
  CheckIcon,
  CloseIcon,
  InfoIcon,
  LockIcon,
  MailIcon,
  RefreshIcon,
  SaveIcon,
  UndoIcon,
} from '../ui/icons'
import { toolboxErrorLabel } from '../settings/toolboxCopy'
import { AiButtons, AiPanel, GeneratedNote } from './AiDraft'
import {
  type AiInstruction,
  aiAvailability,
  GENERATION_DEADLINE_MS,
  generationConfirmation,
  generationNotice,
  generationPayload,
  generationRefusal,
  hasText,
} from './aiDraftModel'
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
  remoteDraftLine,
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
  // The AI « consigne » of this step (kept by the sequence across tab switches).
  instruction: AiInstruction
  onInstruction: (instruction: AiInstruction) => void
}

type Pending = 'validate' | 'schedule' | 'cancel' | 'generate'

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
  instruction,
  onInstruction,
}: MailEditorProps) {
  const [refusal, setRefusal] = useState<MessageRefusal | null>(null)
  // The outcome of the last action, kept while the message stays in the status that action left it in (a state
  // change elsewhere that cancels the message makes it stale).
  const [notice, setNotice] = useState<{ text: string; status: MessageStatus; warning?: boolean } | null>(null)
  const [pending, setPending] = useState<Pending | null>(null)
  const { date, time } = when
  // A confirmed action removes its own button (« Valider… » once validated…): the focus goes to the status sentence,
  // which reads the new status, once the confirmation has closed.
  const statusRef = useRef<HTMLParagraphElement>(null)
  const focusStatus = useRef(false)
  // Bumped when an outcome without a confirmation (an AI draft) should take the focus too.
  const [focusTick, setFocusTick] = useState(0)
  useEffect(() => {
    if (pending !== null || !focusStatus.current) return
    focusStatus.current = false
    statusRef.current?.focus()
  }, [pending, focusTick])
  const [scheduleError, setScheduleError] = useState<string | null>(null)
  const label = STEP_LABELS[step]
  const dirty = actions.editable && isDirty(form, saved)
  const generating = mutations.generate.isPending
  const busy = mutations.save.isPending || mutations.act.isPending || mutations.schedule.isPending || generating
  // The running AI request's step (the mutation is shared by the sequence's tabs).
  const generatingStep = generating ? mutations.generate.variables.step : null
  const generatingHere = generatingStep === step
  const ai = aiAvailability({
    message,
    editable: actions.editable,
    available: sequence.defaults.generation_available,
    busy,
    generatingStep,
    step,
  })
  const textEdited = actions.editable && (form.subject !== saved.subject || form.body !== saved.body)
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

  async function act(action: 'validate' | 'unschedule' | 'cancel' | 'reopen' | 'remote-draft') {
    if (!message) return
    setNotice(null)
    setRefusal(null)
    try {
      const result = await mutations.act.mutateAsync({ step, action, revision: message.revision })
      focusStatus.current = action !== 'unschedule' && action !== 'remote-draft'
      const outcome = result.remote_draft
      const created = outcome?.status === 'created' || outcome?.status === 'recovered'
      const remoteFailed = outcome?.status === 'failed'
      const reason = outcome?.code ? toolboxErrorLabel(outcome.code) : 'erreur inattendue'
      setNotice({
        status: result.message.status,
        warning: remoteFailed,
        text: {
          validate: created
            ? `Message ${label} validé et brouillon créé dans Infomaniak : il peut maintenant être programmé.`
            : remoteFailed
              ? `Message ${label} validé, mais le brouillon Infomaniak n’a pas été créé : ${reason}. La validation est conservée ; « Réessayer » le recrée.`
              : `Message ${label} validé : il peut maintenant être programmé.`,
          unschedule: `Programmation du message ${label} retirée : il reste validé.`,
          cancel: `Message ${label} annulé : il ne partira pas.`,
          reopen: `Message ${label} rouvert en Brouillon : à relire puis revalider.`,
          'remote-draft': created
            ? `Brouillon du message ${label} ${outcome.status === 'recovered' ? 'retrouvé et rattaché' : 'créé'} dans Infomaniak.`
            : `Le brouillon Infomaniak du message ${label} n’a pas pu être créé : ${reason}.`,
        }[action],
      })
    } catch (caught) {
      failed(caught)
    } finally {
      setPending(null)
    }
  }

  // The AI draft (decision 22): the answer replaces the shown text and stays a Brouillon to review.
  async function generate() {
    setNotice(null)
    setRefusal(null)
    try {
      const result = await mutations.generate.mutateAsync({
        step,
        request: generationPayload(message, instruction.text),
        deadline: GENERATION_DEADLINE_MS,
      })
      onForm(undefined)
      setNotice({ status: result.message.status, text: generationNotice(step, result) })
      // The draft's status sentence takes the focus (the button that started it was disabled meanwhile).
      focusStatus.current = true
      setFocusTick((tick) => tick + 1)
    } catch (caught) {
      const view = generationRefusal(caught)
      setRefusal(view)
      if (view.reload) onReload()
    } finally {
      setPending(null)
    }
  }

  function requestGenerate() {
    if (generationConfirmation(step, message, dirty)) setPending('generate')
    else void generate()
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
    if (pending === 'generate') {
      const asked = generationConfirmation(step, message, dirty)
      if (asked) {
        return { ...asked, confirmLabel: hasText(message) ? 'Remplacer par la proposition' : 'Générer avec l’IA' }
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
    else if (pending === 'generate') {
      // The AI can take minutes: the dialog closes at once, the running state says the rest.
      setPending(null)
      void generate()
    }
    else if (pending === 'validate' || pending === 'cancel') void act(pending)
  }

  const toolboxConnected = sequence.defaults.toolbox_state === 'connected'
  const remote = remoteDraftLine(message, sequence.defaults.toolbox_state)
  const retrying = mutations.act.isPending && mutations.act.variables.action === 'remote-draft'
  const errorOf = (field: MailField) => refusal?.fields[field] ?? local[field]
  const readOnly = !actions.editable || busy
  const hasLocalErrors = Object.keys(local).length > 0
  const waitSave = dirty ? 'Enregistrez d’abord les modifications.' : undefined

  return (
    <div className="contact-mail">
      <p ref={statusRef} tabIndex={-1} className="contact-mail__status">
        {statusLine(message, sequence.sequence.closed || sequence.sequence.do_not_contact)}
      </p>

      {remote && (
        <p className={`contact-mail__remote contact-mail__remote--${remote.tone}`}>
          {remote.tone === 'ok' ? (
            <CheckCircleIcon size={16} />
          ) : remote.tone === 'warning' ? (
            <AlertIcon size={16} />
          ) : (
            <MailIcon size={16} />
          )}
          <span>{remote.text}</span>
          {remote.retry && (
            <Button
              size="sm"
              variant="ghost"
              icon={RefreshIcon}
              loading={retrying}
              disabled={busy}
              onClick={() => void act('remote-draft')}
            >
              {retrying ? 'Création dans Infomaniak…' : 'Réessayer'}
            </Button>
          )}
        </p>
      )}

      {actions.lock && (
        <p className="contact-mail__lock">
          <LockIcon size={16} />
          {actions.lock}
        </p>
      )}

      <GeneratedNote message={message} textEdited={textEdited} />

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
        {toolboxConnected && actions.editable && (
          <p className="contact-mail__hint contact-mail__from-note">
            <InfoIcon size={14} />
            Envoi réel depuis la boîte Infomaniak par défaut du compte connecté à la Toolbox : ce champ n’est pas
            transmis.
          </p>
        )}
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
      <Notice
        text={notice && notice.status === status ? notice.text : null}
        tone={notice?.warning ? 'warning' : 'success'}
      />

      <AiPanel
        stepLabel={label}
        availability={ai}
        startedAt={generatingHere ? mutations.generate.submittedAt : null}
        instructionOpen={instruction.open}
        instructionId={fieldId('ai')}
        instruction={instruction.text}
        onInstruction={(text) => {
          onInstruction({ ...instruction, text })
        }}
      />

      {(ai.show || Object.values(actions).some((value) => value === true)) && (
        <div className="contact-mail__actions">
          <div className="contact-mail__assist">
            <AiButtons
              availability={ai}
              running={generatingHere}
              instructionOpen={instruction.open}
              instructionId={fieldId('ai')}
              onToggleInstruction={() => {
                onInstruction({ ...instruction, open: !instruction.open })
              }}
              onGenerate={requestGenerate}
            />
          </div>
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
