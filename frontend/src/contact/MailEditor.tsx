import { type ReactNode, useEffect, useRef, useState } from 'react'

import type { Message, MessageSequence, MessageStatus, MessageStep, ReviewVerdict, useMessageMutations } from '../api/contact'
import { Button } from '../ui/Button'
import { AlertIcon, CheckCircleIcon, InfoIcon, LockIcon, MailIcon, MinusCircleIcon, RefreshIcon } from '../ui/icons'
import { toolboxErrorLabel } from '../settings/toolboxCopy'
import { AdvancedSettings } from './AdvancedSettings'
import { AiProgress, generatedSignal } from './AiDraft'
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
import { inactiveSentence, reasonCopy } from './dispatchCopy'
import { DispatchWarning } from './DispatchWarning'
import { formatDateTime, MESSAGE_BADGES, stepLabel } from './labels'
import { MailActionBar } from './MailActionBar'
import { MailSignals, type Signal, type SignalTone } from './MailSignals'
import {
  BODY_MAX_LENGTH,
  contentOf,
  type DispatchState,
  dispatchLine,
  inactiveScheduleText,
  isDirty,
  latenessLabel,
  localErrors,
  localZoneLabel,
  type MailActions,
  type MailForm,
  orderWarning,
  remoteDraftLine,
  scheduleToIso,
  statusLine,
} from './mailModel'
import { Notice } from './Notice'
import { RecipientsButton } from './RecipientsPopover'
import { ReviewVerdictControl } from './ReviewVerdict'
import { SchedulePopover } from './SchedulePopover'
import { type MailField, type MessageRefusal, messageRefusal } from './messages'

import './mail-editor.css'

type Mutations = ReturnType<typeof useMessageMutations>

// The steps the AI already tried to prepare on arrival (once per prospect and step, whatever the outcome): a failure or a
// deleted draft is never retried behind the person's back.
const autoDrafted = new Set<string>()
export function forgetAutoDrafts() {
  autoDrafted.clear()
}

interface MailEditorProps {
  // The workbench's « Précédent » / « Suivant », on the action bar's row.
  navigation?: ReactNode
  step: MessageStep
  sequence: MessageSequence
  message: Message | null
  actions: MailActions
  // Where the scheduled send stands (S7), judged when the sequence was read.
  dispatch: DispatchState
  // When « Remettre en Validé » of an unconfirmed send becomes possible (epoch ms); null = now.
  releaseFrom: number | null
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

type Pending = 'validate' | 'save-validate' | 'validate-schedule' | 'schedule' | 'cancel' | 'delete' | 'generate' | 'mark-sent' | 'release'

export interface SendMoment {
  date: string
  time: string
}

const SIGNAL_TONES = { success: 'ok', warning: 'warning', danger: 'danger', info: 'info', neutral: 'muted' } as const satisfies Record<
  string,
  SignalTone
>

// One step's message: a slim toolbar (the recipients on one line, the status and every notice as icons with their detail
// in a popover), the subject, the body on all the height left, and one action row (create / save — never validates —,
// validate…, schedule…, unschedule, reopen; cancel and delete behind « … »). A sent message is read-only; a closed
// sequence locks the editor with its reason.
export function MailEditor({
  step,
  sequence,
  message,
  actions,
  dispatch: dispatchNow,
  releaseFrom,
  saved,
  form,
  onForm,
  mutations,
  onReload,
  when,
  onWhen,
  instruction,
  onInstruction,
  navigation,
}: MailEditorProps) {
  const [refusal, setRefusal] = useState<MessageRefusal | null>(null)
  // The outcome of the last action, kept while the message stays in the status that action left it in (a state
  // change elsewhere that cancels the message makes it stale).
  const [notice, setNotice] = useState<{ text: string; status: MessageStatus; warning?: boolean } | null>(null)
  const [pending, setPending] = useState<Pending | null>(null)
  // The sentence kept after a draft was removed (no message is left to carry it).
  const [removed, setRemoved] = useState<string | null>(null)
  // « Créer le brouillon » with nothing written and no AI to write it: said instead of saving an empty draft.
  const [needText, setNeedText] = useState(false)
  const { date, time } = when
  // A confirmed action removes its own button (« Valider… » once validated…): the focus goes to the status sentence,
  // which reads the new status, once the confirmation has closed.
  const toolbarRef = useRef<HTMLDivElement>(null)
  const focusStatus = useRef(false)
  // Bumped when an outcome without a confirmation (an AI draft) should take the focus too.
  const [focusTick, setFocusTick] = useState(0)
  useEffect(() => {
    if (pending !== null || !focusStatus.current) return
    focusStatus.current = false
    toolbarRef.current?.querySelector<HTMLElement>('[data-signal="status"]')?.focus()
  }, [pending, focusTick])
  const [scheduleProblem, setScheduleProblem] = useState<string | null>(null)
  // The one popover open (recipients, send moment, an icon's detail), and the control that opens the send moment's.
  const [openId, setOpenId] = useState<string | null>(null)
  const [scheduleAnchor, setScheduleAnchor] = useState<HTMLElement | null>(null)
  // « Remettre en Validé » opens at `releaseFrom`: a timer re-renders the editor then.
  const [openedAt, setOpenedAt] = useState<number | null>(null)
  useEffect(() => {
    if (releaseFrom === null) return
    const timer = window.setTimeout(
      () => {
        setOpenedAt(releaseFrom)
      },
      Math.max(0, releaseFrom - Date.now()),
    )
    return () => {
      window.clearTimeout(timer)
    }
  }, [releaseFrom])
  const label = stepLabel(step)
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

  // Arriving on the step to send next with nothing written: the AI prepares the draft at once (once per prospect and
  // step); the person only reads it and edits it by hand if needed.
  const autoKey = `${sequence.sequence.prospect_id}:${step}`
  const wantsDraft =
    actions.editable &&
    sequence.defaults.generation_available &&
    sequence.sequence.next_step === step &&
    !hasText(message) &&
    !textEdited &&
    !busy
  useEffect(() => {
    if (!wantsDraft || autoDrafted.has(autoKey)) return
    autoDrafted.add(autoKey)
    void generate()
  })

  function edit(patch: Partial<MailForm>) {
    onForm({ ...form, ...patch })
    setNeedText(false)
    setNotice(null)
    setRefusal(null)
  }

  // A new refusal says itself at once, where it applies: on the recipients, the send moment, or as the error icon.
  function refuse(view: MessageRefusal) {
    setRefusal(view)
    const recipients = (['from', 'to', 'cc', 'bcc'] as const).some((field) => view.fields[field])
    setOpenId(recipients ? 'recipients' : view.fields.schedule !== undefined && scheduleAnchor ? 'schedule' : 'refusal')
    if (view.reload) onReload()
  }

  function failed(caught: unknown) {
    refuse(messageRefusal(caught))
  }

  async function saveForm() {
    setNotice(null)
    setRefusal(null)
    // Nothing written: « Créer le brouillon » has the AI write it (the draft is created with its text); without the AI,
    // an empty draft is never created.
    if (!message && !form.subject.trim() && !form.body.trim()) {
      if (sequence.defaults.generation_available && !busy) {
        setNeedText(false)
        await generate()
      } else {
        setNeedText(true)
        setOpenId('need-text')
      }
      return
    }
    setNeedText(false)
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

  async function review(verdict: ReviewVerdict | null) {
    if (!message) return
    setNotice(null)
    setRefusal(null)
    try {
      await mutations.review.mutateAsync({ step, revision: message.revision, verdict })
    } catch (caught) {
      failed(caught)
    }
  }

  async function act(action: 'validate' | 'unschedule' | 'cancel' | 'reopen' | 'remote-draft' | 'mark-sent' | 'release') {
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
          'mark-sent': `Message ${label} marqué envoyé : il ne peut plus être modifié.`,
          release:
            result.message.status === 'cancelled'
              ? `Message ${label} remis en Validé puis annulé : la séquence du prospect est close.`
              : `Message ${label} remis en Validé, sans date d’envoi : vérifiez la boîte Infomaniak avant de le reprogrammer.`,
        }[action],
      })
    } catch (caught) {
      failed(caught)
    } finally {
      setPending(null)
    }
  }

  // « Enregistrer et valider »: the edited text is saved, then the saved revision is validated, in one click. A refusal
  // of the save leaves the message as it was; a refusal of the validation leaves it saved (a Brouillon), safely.
  async function saveAndValidate() {
    setNotice(null)
    setRefusal(null)
    let saved = false
    try {
      const result = await mutations.save.mutateAsync({ step, content: contentOf(form, message?.revision ?? null) })
      saved = true
      onForm(undefined)
      const validated = await mutations.act.mutateAsync({ step, action: 'validate', revision: result.message.revision })
      const outcome = validated.remote_draft
      const created = outcome?.status === 'created' || outcome?.status === 'recovered'
      const remoteFailed = outcome?.status === 'failed'
      focusStatus.current = true
      setNotice({
        status: validated.message.status,
        warning: remoteFailed,
        text: remoteFailed
          ? `Message ${label} enregistré et validé, mais le brouillon Infomaniak n’a pas été créé : ${outcome.code ? toolboxErrorLabel(outcome.code) : 'erreur inattendue'}. La validation est conservée ; « Réessayer » le recrée.`
          : created
            ? `Message ${label} enregistré et validé, brouillon créé dans Infomaniak : il peut maintenant être programmé.`
            : `Message ${label} enregistré et validé : il peut maintenant être programmé.`,
      })
    } catch (caught) {
      failed(caught)
      if (saved) focusStatus.current = true
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
        request: generationPayload(message, instruction),
        deadline: GENERATION_DEADLINE_MS,
      })
      onForm(undefined)
      setNotice({ status: result.message.status, text: generationNotice(step, result) })
      // The draft's status sentence takes the focus (the button that started it was disabled meanwhile).
      focusStatus.current = true
      setFocusTick((tick) => tick + 1)
    } catch (caught) {
      refuse(generationRefusal(caught))
    } finally {
      setPending(null)
    }
  }

  function requestGenerate() {
    if (generationConfirmation(step, message, dirty)) setPending('generate')
    else void generate()
  }

  // A draft never validated is removed for good (a validated or scheduled message is cancelled instead).
  async function removeDraft() {
    if (!message) return
    setNotice(null)
    setRefusal(null)
    try {
      await mutations.remove.mutateAsync({ step, revision: message.revision })
      onForm(undefined)
      onWhen({ date: '', time: '' })
      setRemoved(`Brouillon ${label} supprimé : l’étape est de nouveau vide.`)
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

  // « Valider et programmer »: a date or a time typed on a draft turns « Valider… » into the two steps in one.
  async function validateAndSchedule(iso: string) {
    if (!message) return
    setNotice(null)
    setRefusal(null)
    let validated = false
    try {
      const result = await mutations.act.mutateAsync({ step, action: 'validate', revision: message.revision })
      validated = true
      const scheduled = await mutations.schedule.mutateAsync({ step, revision: result.message.revision, at: iso })
      onWhen({ date: '', time: '' })
      focusStatus.current = true
      setNotice({
        status: scheduled.message.status,
        text: `Message ${label} validé et programmé pour le ${formatDateTime(scheduled.message.scheduled_at ?? iso)}.`,
      })
    } catch (caught) {
      // Validated but not scheduled (a refused date, a stale revision): the message stays validated, safely.
      failed(caught)
      if (validated) focusStatus.current = true
    } finally {
      setPending(null)
    }
  }

  const parsed = scheduleToIso(date, time, new Date())
  const withDate = date !== '' || time !== ''
  // The offset shown is the chosen day's (summer / winter time), today's until a day is chosen.
  const zoneAt = parsed.ok ? parsed.at : /^\d{4}-\d{2}-\d{2}$/.test(date) ? new Date(`${date}T12:00:00`) : new Date()
  const warning = actions.schedule || actions.validate ? orderWarning(step, sequence, parsed.ok ? parsed.at : null) : null

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
    if (pending === 'save-validate') {
      return {
        title: `Enregistrer et valider le message ${label} ?`,
        lines: [
          'Le texte modifié est enregistré, puis le message est validé : vous confirmez avoir relu les destinataires, l’objet et le corps. Rien n’est envoyé maintenant : le message pourra ensuite être programmé.',
          'Toute modification ultérieure le repassera en Brouillon et demandera une nouvelle validation.',
        ],
        confirmLabel: 'Enregistrer et valider',
      }
    }
    if (pending === 'validate-schedule' && parsed.ok) {
      const lines = [
        'Vous confirmez avoir relu les destinataires, l’objet et le corps.',
        `Envoi prévu le ${formatDateTime(parsed.iso)} (${localZoneLabel(parsed.at)}).`,
      ]
      if (sequence.defaults.automatic_sending_active) {
        lines.push(
          'Le mail partira automatiquement à cette date depuis la boîte Infomaniak connectée à la Toolbox (le serveur VIPER doit être en marche).',
          `S’il ne peut pas partir dans les ${latenessLabel(sequence.defaults.dispatch_max_lateness_minutes)} qui suivent, il ne part pas et revient à « Validé ».`,
          'Toute modification ultérieure le repassera en Brouillon ; vous pourrez le déprogrammer jusqu’à l’envoi.',
        )
        return { title: `Valider et programmer le message ${label} ?`, lines, warning, confirmLabel: 'Valider et programmer' }
      }
      lines.push('Vous pourrez déprogrammer tant que le message n’est pas envoyé.')
      return {
        title: `Valider et programmer le message ${label} ?`,
        lines,
        warning,
        dispatch: { reason: sequence.defaults.dispatch_reason, text: inactiveSentence(sequence.defaults.dispatch_reason) },
        confirmLabel: 'Valider et programmer quand même',
      }
    }
    if (pending === 'schedule' && parsed.ok) {
      const lines = [`Envoi prévu le ${formatDateTime(parsed.iso)} (${localZoneLabel(parsed.at)}).`]
      if (sequence.defaults.automatic_sending_active) {
        lines.push(
          'Le mail partira automatiquement à cette date depuis la boîte Infomaniak connectée à la Toolbox (le serveur VIPER doit être en marche).',
          `S’il ne peut pas partir dans les ${latenessLabel(sequence.defaults.dispatch_max_lateness_minutes)} qui suivent, il ne part pas et revient à « Validé ».`,
          'Vous pourrez le déprogrammer jusqu’à l’envoi.',
        )
        return { title: `Programmer le message ${label} ?`, lines, warning, confirmLabel: 'Programmer l’envoi' }
      }
      lines.push('Vous pourrez déprogrammer tant que le message n’est pas envoyé.')
      // S9: scheduling stays possible, but the person reads that it will not leave, and where to fix it.
      return {
        title: `Programmer le message ${label} ?`,
        lines,
        warning,
        dispatch: { reason: sequence.defaults.dispatch_reason, text: inactiveSentence(sequence.defaults.dispatch_reason) },
        confirmLabel: 'Programmer quand même',
      }
    }
    if (pending === 'mark-sent') {
      return {
        title: `Marquer le message ${label} comme envoyé ?`,
        lines: [
          'Confirmez seulement après l’avoir trouvé dans les éléments envoyés de la boîte Infomaniak.',
          'Il passera en « Envoyé » et ne pourra plus être modifié. VIPER ne l’enverra pas.',
        ],
        confirmLabel: 'Marquer envoyé',
      }
    }
    if (pending === 'release') {
      return {
        title: `Remettre le message ${label} en Validé ?`,
        lines: [
          'Confirmez seulement après avoir vérifié qu’il n’est pas dans les éléments envoyés de la boîte Infomaniak : s’il était parti, le reprogrammer l’enverrait une seconde fois.',
          'Il redevient « Validé », sans date d’envoi, et pourra être reprogrammé.',
        ],
        confirmLabel: 'Remettre en Validé',
        danger: true,
      }
    }
    if (pending === 'generate') {
      const asked = generationConfirmation(step, message, dirty)
      if (asked) {
        return { ...asked, confirmLabel: hasText(message) ? 'Remplacer par la proposition' : 'Générer avec l’IA' }
      }
    }
    if (pending === 'delete') {
      const draft = message?.status === 'draft'
      return {
        title: `Supprimer ${draft ? 'le brouillon' : 'le message'} ${label} ?`,
        lines: [
          `Le texte ${draft ? 'du brouillon' : 'du message'} est effacé définitivement et l’étape redevient vide : vous pourrez en écrire un autre.`,
          draft
            ? 'Rien n’a été validé ni programmé, donc rien ne part.'
            : 'Il n’est pas programmé, donc rien ne part ; son éventuel brouillon Infomaniak est supprimé aussi.',
        ],
        confirmLabel: draft ? 'Supprimer le brouillon' : 'Supprimer le message',
        danger: true,
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
    setScheduleProblem(null)
    if (!parsed.ok) {
      setScheduleProblem(parsed.error)
      return
    }
    setOpenId(null)
    setPending('schedule')
  }

  function requestValidateAndSchedule() {
    setScheduleProblem(null)
    if (!parsed.ok) {
      setScheduleProblem(parsed.error)
      // The moment is typed in the send-moment popover: it opens on the problem.
      if (scheduleAnchor) setOpenId('schedule')
      return
    }
    setPending('validate-schedule')
  }

  function onConfirm() {
    if (pending === 'save-validate') {
      void saveAndValidate()
      return
    }
    if (pending === 'validate-schedule' && parsed.ok) void validateAndSchedule(parsed.iso)
    else if (pending === 'schedule' && parsed.ok) void schedule(parsed.iso)
    else if (pending === 'generate') {
      // The AI can take minutes: the dialog closes at once, the running state says the rest.
      setPending(null)
      void generate()
    }
    else if (pending === 'delete') void removeDraft()
    else if (pending === 'validate' || pending === 'cancel' || pending === 'mark-sent' || pending === 'release') {
      void act(pending)
    }
  }

  const toolboxConnected = sequence.defaults.toolbox_state === 'connected'
  // Under a send in progress or unconfirmed, the draft line would only distract (« créé » reads as reassuring).
  const remote = dispatchNow === 'none' ? remoteDraftLine(message, sequence.defaults.toolbox_state) : null
  const releaseLocked = releaseFrom !== null && openedAt !== releaseFrom
  const releaseLockedText = releaseLocked
    ? `« Remettre en Validé » possible à partir de ${formatDateTime(new Date(releaseFrom).toISOString())} : la Toolbox peut encore être en train de l’envoyer.`
    : null
  const dispatch = dispatchLine(message, sequence.defaults, dispatchNow)
  const retrying = mutations.act.isPending && mutations.act.variables.action === 'remote-draft'
  const errorOf = (field: MailField) => refusal?.fields[field] ?? local[field]
  const readOnly = !actions.editable || busy
  const hasLocalErrors = Object.keys(local).length > 0
  const waitSave = dirty ? 'Enregistrez d’abord les modifications.' : undefined


  // --- what the editor has to say, as icons -------------------------------------------------------------------------
  const closed = sequence.sequence.closed || sequence.sequence.do_not_contact
  const automatic = sequence.defaults.automatic_sending_active
  const statusText = statusLine(message, closed, automatic && dispatchNow === 'none')
  const badge = status ? MESSAGE_BADGES[status] : null
  const signals: Signal[] = [
    {
      id: 'status',
      tone: badge ? SIGNAL_TONES[badge.tone] : 'muted',
      icon: badge?.icon ?? MinusCircleIcon,
      label: statusText,
      detail: <p>{statusText}</p>,
    },
  ]
  if (message?.status === 'scheduled' && !automatic && dispatchNow === 'none') {
    signals.push({
      id: 'wont-send',
      tone: 'warning',
      icon: AlertIcon,
      label: reasonCopy(sequence.defaults.dispatch_reason).badge,
      detail: (
        <DispatchWarning reason={sequence.defaults.dispatch_reason} badge>
          {inactiveScheduleText(message, sequence.defaults, new Date().getTime())}
        </DispatchWarning>
      ),
    })
  }
  if (dispatch) {
    signals.push({
      id: actions.settle ? 'settle' : 'dispatch',
      tone: dispatch.tone === 'progress' ? 'progress' : dispatch.tone === 'ok' ? 'ok' : dispatch.tone === 'warning' ? 'warning' : 'info',
      icon: dispatch.tone === 'warning' ? AlertIcon : InfoIcon,
      label: actions.settle ? 'Envoi non confirmé : à trancher' : dispatch.text,
      detail: (
        <>
          <p>{dispatch.text}</p>
          {actions.settle && releaseLockedText && <p className="mail-popover__meta">{releaseLockedText}</p>}
        </>
      ),
    })
  }
  if (remote) {
    signals.push({
      id: 'remote',
      tone: remote.tone,
      icon: remote.tone === 'ok' ? CheckCircleIcon : remote.tone === 'warning' ? AlertIcon : MailIcon,
      label: remote.text,
      detail: (
        <>
          <p>{remote.text}</p>
          {remote.retry && (
            <Button
              size="sm"
              icon={RefreshIcon}
              loading={retrying}
              disabled={busy}
              onClick={() => void act('remote-draft')}
            >
              {retrying ? 'Création dans Infomaniak…' : 'Réessayer'}
            </Button>
          )}
        </>
      ),
    })
  }
  if (actions.lock) {
    signals.push({ id: 'lock', tone: 'muted', icon: LockIcon, label: actions.lock, detail: <p>{actions.lock}</p> })
  }
  const generated = generatedSignal(message, textEdited)
  if (generated) signals.push(generated)
  if (dirty && (status === 'validated' || status === 'scheduled')) {
    const text =
      status === 'scheduled'
        ? 'Ce message est programmé : l’enregistrer retire la programmation et le repasse en Brouillon. Il faudra le revalider puis le reprogrammer.'
        : 'Ce message est validé : l’enregistrer le repasse en Brouillon. Il faudra le revalider.'
    signals.push({ id: 'dirty', tone: 'warning', icon: AlertIcon, label: text, detail: <p>{text}</p> })
  }
  if (ai.note) signals.push({ id: 'ai-note', tone: 'info', icon: InfoIcon, label: ai.note, detail: <p>{ai.note}</p> })
  if (removed && !message) signals.push({ id: 'removed', tone: 'info', icon: InfoIcon, label: removed, detail: <p>{removed}</p> })
  const shownNotice = notice && notice.status === status ? notice : null
  if (shownNotice) {
    signals.push({
      id: 'notice',
      tone: shownNotice.warning ? 'warning' : 'ok',
      icon: shownNotice.warning ? AlertIcon : CheckCircleIcon,
      label: shownNotice.text,
      detail: <p>{shownNotice.text}</p>,
    })
  }
  if (needText) {
    const text = 'Écrivez l’objet et le texte du message avant de créer le brouillon : la rédaction par l’IA n’est pas disponible.'
    signals.push({ id: 'need-text', tone: 'warning', icon: AlertIcon, label: text, detail: <p>{text}</p>, alert: true })
  }
  if (refusal) {
    signals.push({
      id: 'refusal',
      tone: 'danger',
      icon: AlertIcon,
      label: refusal.message,
      alert: true,
      detail: (
        <>
          <p>{refusal.message}</p>
          {refusal.conflict && dirty && (
            <Button
              size="sm"
              onClick={() => {
                onForm(undefined)
                setRefusal(null)
                setOpenId(null)
              }}
            >
              Voir la version enregistrée
            </Button>
          )}
        </>
      ),
    })
  }

  const scheduleError = scheduleProblem ?? refusal?.fields.schedule
  const advancedCustom = instruction.text.trim() !== '' || instruction.tone !== null || instruction.sender !== null

  return (
    <div className="contact-mail">
      <div ref={toolbarRef} className="mail-toolbar">
        <RecipientsButton
          form={form}
          fieldId={fieldId}
          editable={actions.editable}
          readOnly={readOnly}
          fromInfo={
            toolboxConnected && actions.editable
              ? 'Envoi réel depuis la boîte Infomaniak par défaut du compte connecté à la Toolbox : ce champ n’est pas transmis.'
              : null
          }
          errorOf={errorOf}
          open={openId === 'recipients'}
          onOpenChange={(open) => {
            setOpenId(open ? 'recipients' : null)
          }}
          onEdit={edit}
        />
        <AiProgress stepLabel={label} startedAt={generatingHere ? mutations.generate.submittedAt : null} />
        <MailSignals signals={signals} openId={openId} onOpen={setOpenId} />
        {message && message.status !== 'sent' && message.status !== 'cancelled' && (
          <ReviewVerdictControl
            verdict={message.review_verdict}
            reviewedBy={message.reviewed_by}
            disabled={busy || dirty}
            loading={mutations.review.isPending ? (mutations.review.variables.verdict ?? null) : null}
            onChoose={(verdict) => {
              void review(verdict)
            }}
          />
        )}
      </div>
      {removed && !message && (
        <p className="visually-hidden" role="status">
          {removed}
        </p>
      )}
      {dispatch?.tone === 'progress' && (
        <p className="visually-hidden" role="status">
          {dispatch.text}
        </p>
      )}
      <Notice text={shownNotice?.text ?? null} tone={shownNotice?.warning ? 'warning' : 'success'} quiet />

      <div className="mail-subject">
        <label className="mail-subject__label" htmlFor={fieldId('subject')}>
          Objet
        </label>
        <input
          id={fieldId('subject')}
          className="field__control mail-subject__input"
          value={form.subject}
          readOnly={readOnly}
          maxLength={998}
          aria-invalid={errorOf('subject') ? true : undefined}
          aria-describedby={errorOf('subject') ? `${fieldId('subject')}-error` : undefined}
          onChange={(event) => {
            edit({ subject: event.target.value })
          }}
        />
      </div>
      {errorOf('subject') && (
        <p id={`${fieldId('subject')}-error`} className="field__error">
          <AlertIcon size={16} />
          {errorOf('subject')}
        </p>
      )}
      <div className="mail-body">
        <label className="visually-hidden" htmlFor={fieldId('body')}>
          Corps
        </label>
        <textarea
          id={fieldId('body')}
          className="field__control field__control--multiline mail-body__text"
          value={form.body}
          maxLength={BODY_MAX_LENGTH}
          readOnly={readOnly}
          aria-invalid={errorOf('body') ? true : undefined}
          aria-describedby={errorOf('body') ? `${fieldId('body')}-error` : undefined}
          placeholder={actions.editable ? 'Le message…' : undefined}
          onChange={(event) => {
            edit({ body: event.target.value })
          }}
        />
        {errorOf('body') && (
          <p id={`${fieldId('body')}-error`} className="field__error">
            <AlertIcon size={16} />
            {errorOf('body')}
          </p>
        )}
      </div>

      <MailActionBar
        ai={ai}
        generating={generatingHere}
        onGenerate={requestGenerate}
        advancedOpen={instruction.open}
        advancedCustom={advancedCustom}
        onAdvanced={() => {
          onInstruction({ ...instruction, open: !instruction.open })
        }}
        actions={actions}
        status={status}
        removeLabel={message?.status === 'draft' ? 'Supprimer le brouillon' : 'Supprimer le message'}
        dirty={dirty}
        busy={busy}
        saving={mutations.save.isPending}
        hasLocalErrors={hasLocalErrors}
        waitSave={waitSave}
        withDate={withDate}
        scheduleOpen={openId === 'schedule'}
        unscheduling={mutations.act.isPending && mutations.act.variables.action === 'unschedule'}
        reopening={mutations.act.isPending && mutations.act.variables.action === 'reopen'}
        releaseLocked={releaseLockedText}
        onDiscard={() => {
          onForm(undefined)
          setRefusal(null)
        }}
        onSave={() => void saveForm()}
        onSaveValidate={() => {
          setPending('save-validate')
        }}
        onValidate={() => {
          if (withDate) requestValidateAndSchedule()
          else setPending('validate')
        }}
        onToggleSchedule={(anchor) => {
          setScheduleAnchor(anchor)
          setOpenId(openId === 'schedule' ? null : 'schedule')
        }}
        onUnschedule={() => void act('unschedule')}
        onReopen={() => void act('reopen')}
        onCancel={() => {
          setPending('cancel')
        }}
        onRemove={() => {
          setPending('delete')
        }}
        onMarkSent={() => {
          setPending('mark-sent')
        }}
        onRelease={() => {
          setPending('release')
        }}
        navigation={navigation}
      />

      {openId === 'schedule' && scheduleAnchor && (actions.schedule || actions.validate) && (
        <SchedulePopover
          anchor={scheduleAnchor}
          fieldId={fieldId}
          date={date}
          time={time}
          onChange={(next) => {
            onWhen(next)
            setScheduleProblem(null)
          }}
          zone={localZoneLabel(zoneAt)}
          busy={busy}
          error={scheduleError}
          automatic={automatic}
          dispatchReason={sequence.defaults.dispatch_reason}
          warning={warning}
          confirm={actions.schedule ? { label: 'Programmer l’envoi…', onClick: requestSchedule } : null}
          optional={actions.validate}
          onClose={() => {
            setOpenId(null)
          }}
        />
      )}

      <AdvancedSettings
        open={instruction.open}
        onClose={() => {
          onInstruction({ ...instruction, open: false })
        }}
        stepLabel={label}
        idPrefix={fieldId('ai')}
        instruction={instruction}
        onInstruction={onInstruction}
        running={generatingHere}
        body={form.body}
        humanizer={sequence.defaults.humanizer}
      />

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
