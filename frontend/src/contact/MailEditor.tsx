import { type ReactNode, useEffect, useRef, useState } from 'react'

import type { Message, MessageSequence, MessageStatus, MessageStep, MessageVersion, SavedMailNote, useMessageMutations } from '../api/contact'
import { Button } from '../ui/Button'
import { AlertIcon, CheckCircleIcon, InfoIcon, LockIcon, MailIcon, MinusCircleIcon, RefreshIcon, SpinnerIcon } from '../ui/icons'
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
  stepContext,
  validationNotice,
} from './mailModel'
import { Notice } from './Notice'
import { RecipientsButton } from './RecipientsPopover'
import { VersionsControl } from './MailVersions'
import { SaveMailPopover } from './SaveMail'
import { SchedulePopover } from './SchedulePopover'
import { sendReason } from './sendReason'
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
  // An edit of this visit removed the step's validation (kept by the sequence across tab switches).
  invalidated: boolean
  onInvalidated: (value: boolean) => void
  // Reads the sequence again (after a refusal saying the server's message differs).
  onReload: () => void
  // The send moment typed for this step (kept by the sequence across tab switches).
  when: SendMoment
  onWhen: (when: SendMoment) => void
  // The AI « consigne » of this step (kept by the sequence across tab switches).
  instruction: AiInstruction
  onInstruction: (instruction: AiInstruction) => void
}

type Pending =
  | 'validate'
  | 'validate-schedule'
  | 'schedule'
  | 'cancel'
  | 'delete'
  | 'generate'
  | 'mark-sent'
  | 'release'
  | 'restore'

// What is typed is kept in the draft by itself, this long after the last keystroke (and at once on blur, a tab switch,
// a validation, a regeneration or a restoration).
export const AUTOSAVE_DELAY_MS = 1500

export interface SendMoment {
  date: string
  time: string
}

const SIGNAL_TONES = { success: 'ok', warning: 'warning', danger: 'danger', info: 'info', neutral: 'muted' } as const satisfies Record<
  string,
  SignalTone
>

// One step's message: a slim toolbar (the recipients on one line, the status and every notice as icons with their detail
// in a popover), the subject, the body on all the height left, and one action row (regenerate, advanced settings,
// versions, save as a reference, validate / schedule…, unschedule, reopen; cancel and delete behind « … »). There is no
// « Enregistrer »: what is typed is autosaved into the current draft. Editing a validated or scheduled message is not
// asked about: it goes back to Brouillon (to validate again before any send) and a line above the subject says so, with
// the send date it lost. A sent message is read-only; a closed sequence locks the editor with its reason.
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
  invalidated,
  onInvalidated,
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
  // Autosave: when the draft last took the typed text (null: not in this visit), and the version waiting to be restored.
  const [savedAt, setSavedAt] = useState<number | null>(null)
  const [restoring, setRestoring] = useState<MessageVersion | null>(null)
  const [keepError, setKeepError] = useState<string | null>(null)
  const [keepAnchor, setKeepAnchor] = useState<HTMLElement | null>(null)
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
  const formRef = useRef(form)
  const inFlight = useRef<Promise<Message | null> | null>(null)
  useEffect(() => {
    formRef.current = form
  })
  const generating = mutations.generate.isPending
  const saving = mutations.save.isPending
  const busy = saving || mutations.act.isPending || mutations.schedule.isPending || mutations.restore.isPending || generating
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
    // Text typed back to the saved version is no edit: nothing kept, so nothing can be saved later and take a
    // validation or a schedule away. While a save runs the saved version is about to change: the text is kept.
    const next = { ...form, ...patch }
    onForm(isDirty(next, saved) || inFlight.current ? next : undefined)
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

  // The typed text goes into the current draft: nothing to click, nothing to confirm. Answers the message as it stands
  // afterwards, null when the save was refused.
  async function persist(): Promise<Message | null> {
    // One save at a time: a second call (a blur, then the tab being left) shares the running one, never sends it twice.
    if (inFlight.current) return inFlight.current
    const snapshot = formRef.current
    if (!actions.editable || !isDirty(snapshot, saved)) return message
    if (!message && !snapshot.subject.trim() && !snapshot.body.trim()) return message
    const run = (async (): Promise<Message | null> => {
      try {
        const result = await mutations.save.mutateAsync({ step, content: contentOf(snapshot, message?.revision ?? null) })
        // Typed meanwhile: that text stays in the form and is saved next.
        if (!isDirty(formRef.current, snapshot)) onForm(undefined)
        setSavedAt(Date.now())
        if (result.unvalidated) onInvalidated(true)
        if (result.created) setNotice({ status: result.message.status, text: `Brouillon ${label} créé.` })
        else if (result.unvalidated) {
          setNotice({ status: result.message.status, text: `Message ${label} repassé en Brouillon : à revalider.` })
        }
        return result.message
      } catch (caught) {
        failed(caught)
        return null
      } finally {
        inFlight.current = null
      }
    })()
    inFlight.current = run
    return run
  }
  const persistRef = useRef(persist)
  // Leaving a field saves at once rather than after the delay.
  function flushNow() {
    if (canPersist && !busy && pending === null) void persist()
  }
  const canPersist = actions.editable && dirty && Object.keys(local).length === 0 && refusal === null
  useEffect(() => {
    if (!canPersist || busy || pending !== null) return
    const timer = window.setTimeout(() => {
      void persistRef.current()
    }, AUTOSAVE_DELAY_MS)
    return () => {
      window.clearTimeout(timer)
    }
  }, [canPersist, busy, pending, form])
  // Leaving the step (another tab, another prospect) keeps what was typed.
  const leaving = useRef(false)
  useEffect(() => {
    persistRef.current = persist
    leaving.current = canPersist && !saving
  })
  useEffect(
    () => () => {
      if (leaving.current) void persistRef.current()
    },
    [],
  )

  async function act(action: 'validate' | 'unschedule' | 'cancel' | 'reopen' | 'remote-draft' | 'mark-sent' | 'release') {
    if (!message) return
    setNotice(null)
    setRefusal(null)
    try {
      // « Valider » takes what is typed with it: the validated revision is the one shown.
      const target = action === 'validate' && dirty ? await persist() : message
      if (!target) return
      const result = await mutations.act.mutateAsync({ step, action, revision: target.revision })
      onInvalidated(false)
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
              ? `Message ${label} remis en Validé puis annulé${result.message.cancel_reason === 'sequence_limit' ? ' : trois e-mails au plus.' : ' : la séquence du prospect est close.'}`
              : `Message ${label} remis en Validé, sans date d’envoi : vérifiez la boîte Infomaniak avant de le reprogrammer.`,
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
      // What is typed becomes a version before the AI replaces it.
      const target = dirty ? await persist() : message
      if (dirty && !target) return
      const result = await mutations.generate.mutateAsync({
        step,
        request: generationPayload(target, instruction),
        deadline: GENERATION_DEADLINE_MS,
      })
      onForm(undefined)
      if (result.unvalidated) onInvalidated(true)
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
    if (generationConfirmation(step, message)) setPending('generate')
    else void generate()
  }

  // A draft never validated is removed for good (a validated or scheduled message is cancelled instead).
  async function removeDraft() {
    if (!message) return
    setNotice(null)
    setRefusal(null)
    try {
      await mutations.remove.mutateAsync({ step, revision: message.revision, sentCheckConfirmed: message.needs_sent_check })
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
      // The confirmation the person just accepted said « vérifié » when the earlier send may have left.
      const result = await mutations.schedule.mutateAsync({ step, revision: message.revision, at: iso, sentCheckConfirmed: message.needs_sent_check })
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
      const target = dirty ? await persist() : message
      if (!target) return
      const result = await mutations.act.mutateAsync({ step, action: 'validate', revision: target.revision })
      validated = true
      const scheduled = await mutations.schedule.mutateAsync({ step, revision: result.message.revision, at: iso, sentCheckConfirmed: message.needs_sent_check })
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

  // « Versions »: the chosen text becomes the current draft (the text it replaces stays in the versions).
  async function requestRestore(version: MessageVersion) {
    setOpenId(null)
    const target = dirty ? await persist() : message
    if (!target) return
    if (target.status === 'validated' || target.status === 'scheduled') {
      setRestoring(version)
      setPending('restore')
      return
    }
    await restore(version, target)
  }

  async function restore(version: MessageVersion, target: Message) {
    setNotice(null)
    setRefusal(null)
    try {
      const result = await mutations.restore.mutateAsync({ step, versionId: version.id, revision: target.revision })
      onForm(undefined)
      if (result.unvalidated) onInvalidated(true)
      setNotice({
        status: result.message.status,
        text: !result.changed
          ? 'Ce texte est déjà le texte actuel.'
          : `Version du ${formatDateTime(version.created_at)} rétablie : le texte précédent reste dans les versions.${result.unvalidated ? ' Le message est repassé en Brouillon : à revalider.' : ''}`,
      })
    } catch (caught) {
      failed(caught)
    } finally {
      setPending(null)
      setRestoring(null)
    }
  }

  // « Sauvegarder »: the text shown, with the config it came from and a human note, kept as a reference.
  async function keep(note: SavedMailNote) {
    setKeepError(null)
    const target = dirty ? await persist() : message
    if (!target) return
    try {
      await mutations.keep.mutateAsync({ step, note })
      setOpenId(null)
      setNotice({
        status: target.status,
        text: `Message ${label} sauvegardé avec la note ${String(note.rating)}/10 : il est dans le Suivi de contact.`,
      })
    } catch (caught) {
      setKeepError(messageRefusal(caught).message)
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
    if (pending === 'restore') {
      return {
        title: 'Revenir à cette version ?',
        lines: [
          'Son texte devient le brouillon actuel ; le texte actuel reste dans les versions.',
          status === 'scheduled'
            ? 'Le message est programmé : il perdra sa programmation et repassera en Brouillon.'
            : 'Le message est validé : il repassera en Brouillon et devra être revalidé.',
        ],
        confirmLabel: 'Revenir à cette version',
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
      const asked = generationConfirmation(step, message)
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

  // An earlier send may have left: scheduling again (or deleting the record of it) says so and asks the person to
  // attest they looked.
  function withSentCheck(asked: Confirmation | null): Confirmation | null {
    if (!asked || !message?.needs_sent_check || (pending !== 'schedule' && pending !== 'validate-schedule' && pending !== 'delete')) return asked
    return {
      ...asked,
      warning: [
        'Un envoi précédent de ce mail a peut-être abouti. Vérifiez le dossier Envoyés d’Infomaniak avant de continuer.',
        asked.warning,
      ].filter(Boolean).join(' '),
      confirmLabel: `J’ai vérifié les Envoyés : ${pending === 'delete' ? 'supprimer' : 'programmer'}`,
    }
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
    if (pending === 'restore' && restoring && message) {
      void restore(restoring, message)
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
  // Typing stays possible while the draft saves itself.
  const readOnly = !actions.editable || (busy && !saving)
  const hasLocalErrors = Object.keys(local).length > 0


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
  if (actions.editable && (saving || dirty || savedAt !== null)) {
    const text = saving
      ? 'Enregistrement du brouillon…'
      : dirty
        ? 'Modifications en cours d’enregistrement automatique'
        : `Enregistré à ${new Date(savedAt ?? 0).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })}`
    signals.push({
      id: 'autosave',
      tone: saving ? 'progress' : dirty ? 'muted' : 'ok',
      icon: saving ? SpinnerIcon : dirty ? MinusCircleIcon : CheckCircleIcon,
      label: text,
      detail: (
        <>
          <p>{text}</p>
          <p className="mail-popover__meta">Le texte est enregistré tout seul dans le brouillon ; chaque état reste dans les versions.</p>
        </>
      ),
    })
  }
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
  if (message?.draft_missing && dispatchNow === 'none') {
    const text = 'Brouillon introuvable dans Infomaniak (autre compte, supprimé, ou envoyé à la main) : vérifiez les Envoyés, puis « Recréer » dans Contacts › Envois à reprendre.'
    signals.push({ id: 'draft-missing', tone: 'warning', icon: AlertIcon, label: text, detail: <p>{text}</p> })
  }
  // A mail that may have left is said first; a schedule lost to an edit or to a change of address is said beside the
  // mail (`validationNotice`), the other causes by this icon.
  if (message && message.status !== 'sent' && message.status !== 'scheduled' && message.needs_sent_check) {
    // After the sequence's last step nothing is scheduled or recorded as sent: only the check is left to confirm.
    const text = stepContext(sequence, step).beyondLimit
      ? 'Ce mail est peut-être déjà parti : vérifiez le dossier Envoyés d’Infomaniak. S’il n’y est pas, « Confirmer sans reprogrammer » dans Contacts › Envois à reprendre.'
      : 'Ce mail est peut-être déjà parti : vérifiez le dossier Envoyés d’Infomaniak avant de le reprogrammer, ou « Marquer comme envoyé ».'
    signals.push({ id: 'missed', tone: 'warning', icon: AlertIcon, label: text, detail: <p>{text}</p> })
  } else if (message?.missed_scheduled_at && message.missed_reason !== 'edited' && message.missed_reason !== 'recipient_changed' && (message.status === 'draft' || message.status === 'validated')) {
    const text = `Envoi prévu le ${formatDateTime(message.missed_scheduled_at)} non effectué : ${sendReason(message.missed_reason ?? '')}.`
    signals.push({ id: 'missed', tone: 'warning', icon: AlertIcon, label: text, detail: <p>{text}</p> })
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

  const lost = validationNotice(message, dirty, invalidated)
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

      {/* Always mounted, so the sentence is announced when it appears. */}
      <div role="status">
        {lost && (
          <p className="contact-mail__banner mail-lost">
            <AlertIcon size={16} />
            {lost}
          </p>
        )}
      </div>

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
          onBlur={flushNow}
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
          onBlur={flushNow}
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
        removeLabel={message?.status === 'draft' ? 'Supprimer le brouillon' : 'Supprimer le message'}
        dirty={dirty}
        busy={busy}
        hasLocalErrors={hasLocalErrors}
        versions={
          <VersionsControl
            prospectId={sequence.sequence.prospect_id}
            step={step}
            stepLabel={label}
            message={message}
            shown={{ subject: form.subject, body: form.body }}
            canRestore={actions.editable}
            busy={busy}
            open={openId === 'versions'}
            onOpenChange={(open) => {
              setOpenId(open ? 'versions' : null)
            }}
            onRestore={(version) => void requestRestore(version)}
          />
        }
        canKeep={hasText(message) || form.subject.trim() !== '' || form.body.trim() !== ''}
        keepOpen={openId === 'keep'}
        onKeep={(anchor) => {
          setKeepAnchor(anchor)
          setKeepError(null)
          setOpenId(openId === 'keep' ? null : 'keep')
        }}
        withDate={withDate}
        scheduleOpen={openId === 'schedule'}
        unscheduling={mutations.act.isPending && mutations.act.variables.action === 'unschedule'}
        reopening={mutations.act.isPending && mutations.act.variables.action === 'reopen'}
        releaseLocked={releaseLockedText}
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

      {openId === 'keep' && keepAnchor && (
        <SaveMailPopover
          anchor={keepAnchor}
          stepLabel={label}
          idPrefix={fieldId('keep')}
          saving={mutations.keep.isPending}
          error={keepError}
          onSave={(note) => void keep(note)}
          onClose={() => {
            setOpenId(null)
          }}
        />
      )}

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
        confirmation={withSentCheck(confirmation())}
        busy={busy}
        onConfirm={onConfirm}
        onClose={() => {
          setPending(null)
          setRestoring(null)
        }}
      />
    </div>
  )
}
