import { useEffect, useId, useRef, useState } from 'react'

import { useCompany } from '../api/companies'
import { type Prospect, useProspect, useProspectMutations } from '../api/prospects'
import { civilityLabel, personName, SEGMENT_INFO } from '../prospection/labels'
import type { ProspectEditorProps } from '../prospection/prospectEditor'
import { Button } from '../ui/Button'
import { Drawer, Modal } from '../ui/Dialog'
import { AlertIcon, CheckCircleIcon, InfoIcon, RefreshIcon, TrashIcon } from '../ui/icons'
import { AliasList } from './AliasList'
import { CompanySection, DeleteProspectDialog, ProvenanceSection } from './ContextSections'
import { EmploymentSection, IdentitySection, VerificationSection } from './EmploymentSections'
import { type ProspectRefusal, prospectRefusal } from './messages'
import { OppositionSection } from './OppositionSection'
import {
  draftFromProspect,
  emptyDraft,
  isDirty,
  type NewProspectDefaults,
  payloadIndexes,
  type ProspectDraft,
  toCreateInput,
  toInput,
  validate,
} from './prospectForm'
import { TrackingSection } from './TrackingSection'
import './prospects.css'

interface Forms {
  // The prospect id, or 'new'.
  target: string
  prospect: Prospect | null
  // Last loaded or saved state; `draft` is what the user is typing.
  baseline: ProspectDraft
  draft: ProspectDraft
  // Changes when another person (or a fresh new form) is shown: the first field takes the focus.
  session: number
}

type Notice = 'saved' | 'created_next' | 'end' | 'opposition_set' | 'opposition_cleared'

let sessions = 0

function nextSession(): number {
  sessions += 1
  return sessions
}

// `session`: keep the current one after a save (the focus stays where it is).
function loadedForms(prospect: Prospect, session = nextSession()): Forms {
  const draft = draftFromProspect(prospect)
  return { target: prospect.id, prospect, baseline: draft, draft, session }
}

function newForms(defaults: NewProspectDefaults = {}): Forms {
  const draft = emptyDraft(defaults)
  return { target: 'new', prospect: null, baseline: draft, draft, session: nextSession() }
}

// Today in Circoe's business time zone (`YYYY-MM-DD`), for a prospect the server has not described yet.
function businessToday(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Paris' }).format(new Date())
}

// The Prospect editor (Task 15): one wide drawer for adding and editing a person, opened by the Prospection list
// (contract: prospection/prospectEditor.tsx). Prefilled; what needs verification is shown in warning style; one
// atomic save; « Enregistrer et suivant » follows the list's queue. Ctrl+S saves, Ctrl+Entrée saves and moves on,
// Échap closes (asking first when changes are pending).
export function ProspectEditor({ target, queue, onNavigate }: ProspectEditorProps) {
  const loaded = useProspect(target === 'new' ? null : target)
  const [forms, setForms] = useState<Forms | null>(() => (target === 'new' ? newForms() : null))
  const [shownTarget, setShownTarget] = useState(target)
  const [submitted, setSubmitted] = useState(false)
  const [refusal, setRefusal] = useState<ProspectRefusal | null>(null)
  const [notice, setNotice] = useState<Notice | null>(null)
  const [confirm, setConfirm] = useState<{ action: () => void; label: string } | null>(null)
  const [deleting, setDeleting] = useState(false)
  const [moving, setMoving] = useState(false)

  // Another person (Save & Next, Back/Forward): drop the previous one's form and messages — unless the form already
  // shows it (a prospect just created here).
  if (shownTarget !== target) {
    setShownTarget(target)
    if (forms?.target !== target) {
      setForms(target === 'new' ? newForms() : null)
      setSubmitted(false)
      setRefusal(null)
      setNotice(null)
    }
  }
  if (forms === null && loaded.data?.id === target) setForms(loadedForms(loaded.data))

  const formId = useId()
  const fieldId = (path: string) => `${formId}-${path}`
  const formRef = useRef<HTMLFormElement>(null)
  const firstFieldRef = useRef<HTMLInputElement>(null)
  const mutations = useProspectMutations()
  const saving = mutations.create.isPending || mutations.update.isPending || moving

  const prospect = forms?.prospect ?? null
  const isNew = forms !== null && prospect === null
  const today = prospect?.today ?? businessToday()
  const draft = forms?.draft
  const companyMoved = forms !== null && prospect !== null && forms.draft.company_id !== forms.baseline.company_id
  const company = useCompany(draft?.company_id ?? null)
  const dirty = forms !== null && isDirty(forms.draft, forms.baseline, isNew)
  const errors = forms ? validate(forms.draft, { isNew, today }) : {}
  const shown = submitted ? { ...errors } : {}
  if (refusal?.field) shown[refusal.field] = refusal.message

  useEffect(() => {
    if (forms?.session) firstFieldRef.current?.focus()
  }, [forms?.session])

  function focusField(path: string) {
    document.getElementById(fieldId(path))?.focus()
  }

  function change(patch: Partial<ProspectDraft>) {
    setForms((current) => current && { ...current, draft: { ...current.draft, ...patch } })
    setRefusal((current) => (current?.conflict ? current : null))
    setNotice(null)
  }

  function guarded(action: () => void, label: string) {
    if (dirty) setConfirm({ action, label })
    else action()
  }

  function revert() {
    setForms((current) => current && { ...current, draft: current.baseline })
    setSubmitted(false)
    setRefusal(null)
  }

  // Saves the form; resolves to the saved prospect, or null when the form or the server refused it.
  async function save(): Promise<Prospect | null> {
    if (!forms || saving) return null
    if (!dirty) return forms.prospect
    setSubmitted(true)
    const invalid = Object.keys(validate(forms.draft, { isNew, today }))[0]
    if (invalid) {
      focusField(invalid)
      return null
    }
    try {
      const saved = forms.prospect
        ? await mutations.update.mutateAsync({
            id: forms.prospect.id,
            version: forms.prospect.version,
            input: toInput(forms.draft, forms.baseline.company_id),
          })
        : await mutations.create.mutateAsync(toCreateInput(forms.draft))
      setSubmitted(false)
      setRefusal(null)
      return saved
    } catch (error) {
      const indexes = { emails: payloadIndexes(forms.draft.emails), phones: payloadIndexes(forms.draft.phones) }
      const refused = prospectRefusal(error, indexes)
      setRefusal(refused)
      if (refused.field) focusField(refused.field)
      return null
    }
  }

  async function saveOnly() {
    if (!dirty) return
    const creating = isNew
    const saved = await save()
    if (!saved) return
    setForms(loadedForms(saved, creating ? nextSession() : forms.session))
    setNotice('saved')
    if (creating) onNavigate(saved.id)
  }

  // « Enregistrer et suivant »: save when needed, then the next person of the list's queue (the saved one may have left
  // the segment: the queue reads the list again). A new prospect is followed by a fresh form for the same company.
  async function saveAndNext() {
    if (!forms || saving) return
    if (isNew) {
      if (!dirty) return
      const saved = await save()
      if (!saved) return
      const { legal_context, source_reference } = forms.draft
      setForms(newForms({ company_id: saved.company?.id ?? null, legal_context, source_reference }))
      setNotice('created_next')
      return
    }
    const saved = await save()
    if (!saved) return
    setForms(loadedForms(saved, forms.session))
    setMoving(true)
    try {
      const step = await queue.next(saved.id)
      if (step) onNavigate(step.id, { page: step.page })
      else setNotice('end')
    } catch {
      setRefusal({ field: null, message: 'Le prospect suivant n’a pas pu être chargé. Réessayez.' })
    } finally {
      setMoving(false)
    }
  }

  async function setOpposition(doNotContact: boolean, reason: string) {
    if (!prospect) return
    try {
      const updated = await mutations.contactability.mutateAsync({
        id: prospect.id,
        do_not_contact: doNotContact,
        reason,
        version: prospect.version,
      })
      // Only the opposition changed: the draft stays as typed, on the new version.
      setForms((current) => current && { ...current, prospect: updated })
      setNotice(doNotContact ? 'opposition_set' : 'opposition_cleared')
    } catch (error) {
      const refused = prospectRefusal(error)
      if (refused.conflict) setRefusal(refused)
      throw new Error(refused.message, { cause: error })
    }
  }

  async function reload() {
    const result = await loaded.refetch()
    if (result.data) setForms(loadedForms(result.data))
    setSubmitted(false)
    setRefusal(null)
  }

  // Ctrl+S / ⌘S saves and Ctrl+Entrée saves and moves on, from anywhere in this drawer (not from a dialog above it).
  const actions = useRef({ saveOnly, saveAndNext })
  useEffect(() => {
    actions.current = { saveOnly, saveAndNext }
  })
  useEffect(() => {
    function handle(event: KeyboardEvent) {
      const dialog = formRef.current?.closest('[role="dialog"]')
      if (!dialog || !(event.target instanceof Node) || !dialog.contains(event.target)) return
      if (!(event.ctrlKey || event.metaKey)) return
      if (event.key.toLowerCase() === 's') {
        event.preventDefault()
        void actions.current.saveOnly()
      } else if (event.key === 'Enter') {
        event.preventDefault()
        void actions.current.saveAndNext()
      }
    }
    document.addEventListener('keydown', handle)
    return () => {
      document.removeEventListener('keydown', handle)
    }
  }, [])

  const close = () => {
    onNavigate(null)
  }
  const name = prospect ? [civilityLabel(prospect.civility), personName(prospect)].filter(Boolean).join(' ') : ''
  const position = prospect ? queue.position(prospect.id) : null
  const description = isNew
    ? 'Saisie manuelle : la provenance est enregistrée avec la fiche.'
    : position
      ? `Prospect ${String(position)} sur ${String(queue.total)} · ${SEGMENT_INFO[queue.criteria.segment].label}`
      : 'Chaque enregistrement est tracé dans l’historique.'

  return (
    <Drawer
      open
      size="xl"
      title={isNew ? 'Nouveau prospect' : name || 'Prospect'}
      description={forms ? description : undefined}
      onClose={() => {
        guarded(close, 'Fermer sans enregistrer')
      }}
      footer={
        forms && (
          <div className="prospect-editor__bar">
            <div className="prospect-editor__bar-status" role="status">
              <EditorStatus
                dirty={dirty}
                notice={notice}
                errorCount={submitted ? Object.keys(errors).length : 0}
                refusal={refusal}
                segment={SEGMENT_INFO[queue.criteria.segment].label}
              />
              {refusal?.conflict && (
                <Button size="sm" icon={RefreshIcon} onClick={() => void reload()}>
                  Recharger la fiche
                </Button>
              )}
            </div>
            {prospect && (
              <Button
                variant="ghost"
                icon={TrashIcon}
                onClick={() => {
                  setDeleting(true)
                }}
              >
                Supprimer
              </Button>
            )}
            {dirty ? <Button onClick={revert}>Annuler les modifications</Button> : <Button onClick={close}>Fermer</Button>}
            <Button type="submit" form={formId} loading={mutations.update.isPending || mutations.create.isPending} disabled={!dirty}>
              Enregistrer
            </Button>
            <Button
              variant="primary"
              loading={moving}
              disabled={saving || (isNew && !dirty)}
              onClick={() => void saveAndNext()}
            >
              {isNew ? 'Enregistrer et nouveau' : 'Enregistrer et suivant'}
            </Button>
          </div>
        )
      }
    >
      {forms === null || draft === undefined ? (
        <LoadState failed={loaded.isError} notFound={isNotFound(loaded.error)} onRetry={() => void loaded.refetch()} />
      ) : (
        <form
          id={formId}
          ref={formRef}
          className="prospect-editor"
          noValidate
          onSubmit={(event) => {
            event.preventDefault()
            void saveOnly()
          }}
        >
          <div className="prospect-editor__main">
            <IdentitySection draft={draft} errors={shown} fieldId={fieldId} onChange={change} firstFieldRef={firstFieldRef} />
            <EmploymentSection
              draft={draft}
              errors={shown}
              fieldId={fieldId}
              onChange={change}
              prospect={prospect}
              companyMoved={companyMoved}
            />
            <VerificationSection
              draft={draft}
              errors={shown}
              fieldId={fieldId}
              onChange={change}
              prospect={prospect}
              companyMoved={companyMoved}
              today={today}
            />
            {(['emails', 'phones'] as const).map((kind) => (
              <AliasList
                key={kind}
                kind={kind}
                aliases={draft[kind]}
                onChange={(aliases) => {
                  change({ [kind]: aliases })
                }}
                errors={shown}
                fieldId={fieldId}
                companyMoved={companyMoved}
                companyDomain={company.data?.email_domain ?? null}
                today={today}
                staleDays={prospect?.stale_threshold_days ?? null}
              />
            ))}
          </div>
          <div className="prospect-editor__side">
            <OppositionSection
              prospect={prospect}
              busy={mutations.contactability.isPending}
              pendingChanges={dirty}
              onSubmit={setOpposition}
            />
            <TrackingSection draft={draft} errors={shown} fieldId={fieldId} onChange={change} prospect={prospect} today={today} />
            <CompanySection companyId={draft.company_id} />
            <ProvenanceSection draft={draft} errors={shown} fieldId={fieldId} onChange={change} prospect={prospect} />
          </div>
        </form>
      )}
      {deleting && prospect && (
        <DeleteProspectDialog
          prospect={prospect}
          busy={mutations.remove.isPending}
          error={mutations.remove.isError ? prospectRefusal(mutations.remove.error).message : null}
          onClose={() => {
            setDeleting(false)
            mutations.remove.reset()
          }}
          onConfirm={() => {
            mutations.remove.mutate({ id: prospect.id, version: prospect.version }, { onSuccess: close })
          }}
        />
      )}
      {confirm && (
        <Modal
          open
          size="sm"
          title="Abandonner les modifications ?"
          onClose={() => {
            setConfirm(null)
          }}
          footer={
            <>
              <Button
                onClick={() => {
                  setConfirm(null)
                }}
              >
                Continuer la saisie
              </Button>
              <Button variant="danger" onClick={confirm.action}>
                {confirm.label}
              </Button>
            </>
          }
        >
          <p>Les modifications de cette fiche ne sont pas enregistrées : elles seront perdues.</p>
        </Modal>
      )}
    </Drawer>
  )
}

function isNotFound(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'status' in error && error.status === 404
}

function LoadState({ failed, notFound, onRetry }: { failed: boolean; notFound: boolean; onRetry: () => void }) {
  if (!failed) return <p className="prospect-editor__state">Chargement du prospect…</p>
  return (
    <div className="prospect-editor__state prospect-editor__state--error" role="alert">
      <AlertIcon size={18} />
      {notFound ? 'Ce prospect n’existe plus : il a peut-être été supprimé.' : 'Fiche indisponible.'}
      {!notFound && (
        <Button size="sm" onClick={onRetry}>
          Réessayer
        </Button>
      )}
    </div>
  )
}

const NOTICES: Record<Notice, (segment: string) => string> = {
  saved: () => 'Prospect enregistré.',
  created_next: () => 'Prospect enregistré. Saisissez le suivant : l’entreprise est reprise.',
  end: (segment) => `Fin de la liste « ${segment} » : aucun prospect après celui-ci.`,
  opposition_set: () => 'Opposition enregistrée.',
  opposition_cleared: () => 'Opposition levée.',
}

interface EditorStatusProps {
  dirty: boolean
  notice: Notice | null
  errorCount: number
  refusal: ProspectRefusal | null
  segment: string
}

function EditorStatus({ dirty, notice, errorCount, refusal, segment }: EditorStatusProps) {
  if (refusal) {
    return (
      <span className="prospect-editor__status prospect-editor__status--error">
        <AlertIcon size={16} />
        {refusal.field ? `Enregistrement impossible : ${refusal.message}` : refusal.message}
      </span>
    )
  }
  if (errorCount > 0) {
    return (
      <span className="prospect-editor__status prospect-editor__status--error">
        <AlertIcon size={16} />
        {errorCount > 1 ? `Corrigez les ${String(errorCount)} champs signalés.` : 'Corrigez le champ signalé.'}
      </span>
    )
  }
  if (dirty) {
    return (
      <span className="prospect-editor__status prospect-editor__status--dirty">
        <span className="prospect-editor__dot" aria-hidden="true" />
        Modifications non enregistrées
      </span>
    )
  }
  if (notice) {
    return (
      <span className={`prospect-editor__status prospect-editor__status--${notice === 'end' ? 'info' : 'saved'}`}>
        {notice === 'end' ? <InfoIcon size={16} /> : <CheckCircleIcon size={16} />}
        {NOTICES[notice](segment)}
      </span>
    )
  }
  return (
    <span className="prospect-editor__keys">
      <kbd>Ctrl</kbd>+<kbd>S</kbd> enregistrer · <kbd>Ctrl</kbd>+<kbd>Entrée</kbd> enregistrer et suivant · <kbd>Échap</kbd>{' '}
      fermer
    </span>
  )
}
