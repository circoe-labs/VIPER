import { useEffect, useId, useRef, useState } from 'react'
import { useLocation, useNavigate } from 'react-router'

import { useCompany } from '../api/companies'
import { type Prospect, type ProspectSaved, useProspect, useProspectMutations } from '../api/prospects'
import { businessToday } from '../lib/isoWeek'
import { useElapsed } from '../lib/useElapsed'
import { LifecycleDialog } from '../lifecycle/LifecycleDialog'
import { LifecycleSummary } from '../lifecycle/LifecycleSummary'
import { BLOCK_LABELS } from '../lifecycle/model'
import { initials } from '../prospection/graphLayout'
import { civilityLabel, personName, selectionShortLabel } from '../prospection/labels'
import type { ProspectEditorProps } from '../prospection/prospectEditor'
import { Button, IconButton } from '../ui/Button'
import { Modal } from '../ui/Dialog'
import { AlertIcon, CheckCircleIcon, ChevronLeftIcon, ChevronRightIcon, InfoIcon, PauseIcon, PhoneIcon, RefreshIcon, SpinnerIcon, TrashIcon, UserPlusIcon } from '../ui/icons'
import { Tabs } from '../ui/Tabs'
import { AliasList } from './AliasList'
import { IdentityNotice } from '../identity/IdentityDoubt'
import { CompanySection, DeleteProspectDialog } from './ContextSections'
import { forgetDraft, type KeptDraft, keepDraft, keptDraft } from './draftStorage'
import { EditorSection, type SectionEdit } from './EditorSection'
import { EmploymentSection, IdentitySection } from './EmploymentSections'
import { type ProspectRefusal, prospectRefusal } from './messages'
import {
  dirtyTabs,
  type EditableSection,
  type EditorTab,
  sectionOfField,
  sectionsWithErrors,
  tabOfField,
  tabsWithErrors,
} from './profileEditing'
import { mainAlias, ProfileSummary, useEmploymentLabels } from './ProfileSummary'
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
import { useCompletenessIndicator, useProximityIndicator } from './indicatorSources'
import { ProfileRow } from './ProfileLayout'
import { ProspectIndicatorStrip } from './ProspectIndicatorStrip'
import { ProspectLinksCard } from './ProspectLinksCard'
import { prospectGraphHref } from './prospectGraphHref'
import { ProspectContactButton, ProspectMoreMenu } from './missionMenu/ProspectContactAction'
import { ProspectMissionMenu } from './missionMenu/ProspectMissionMenu'
import { ProspectSheetMenu, useSheetMenu } from './missionMenu/ProspectSheetMenu'
import { ProspectScoreCard } from './ProspectScoreCard'
import { TrackingTab } from './TrackingTab'
import './prospects.css'
import './prospect-sheet.css'
import '../lifecycle/lifecycle.css'

interface Forms {
  // The prospect id, or 'new'.
  target: string
  prospect: Prospect | null
  // Last loaded or saved state; `draft` is what the user is typing.
  baseline: ProspectDraft
  draft: ProspectDraft
  // Changes when another person (or a fresh new form) is shown: the first field takes the focus.
  session: number
  // Profil sections shown as inputs (the others read as a summary of the same draft): those being edited, plus those
  // that were invalid when loaded. A new prospect shows every section as inputs.
  editing: EditableSection[]
}

// `saved:<n>`: saved, and n unsent messages lost their validation because the recipient's address changed.
type Notice = 'saved' | `saved:${number}` | 'created_next' | 'end'

let sessions = 0

function nextSession(): number {
  sessions += 1
  return sessions
}

// `session`: keep the current one after a save (the focus stays where it is).
function loadedForms(prospect: Prospect, session = nextSession()): Forms {
  const draft = draftFromProspect(prospect)
  const editing = sectionsWithErrors(validate(draft, { isNew: false, today: prospect.today }))
  return { target: prospect.id, prospect, baseline: draft, draft, session, editing }
}

// The prospect read again after an operation outside the form's save (cohort, send, « Défaillant », alert): its new
// version and derived contact, and its saved commercial state in the baseline — kept in the draft unless the person
// chose another one there.
export function withServerProspect(forms: Forms, prospect: Prospect): Forms {
  const saved = draftFromProspect(prospect).tracking
  const keep = forms.draft.tracking.status !== forms.baseline.tracking.status
  return {
    ...forms,
    prospect,
    baseline: { ...forms.baseline, tracking: saved },
    draft: keep ? forms.draft : { ...forms.draft, tracking: { ...forms.draft.tracking, status: saved.status } },
  }
}

function newForms(defaults: NewProspectDefaults = {}): Forms {
  const draft = emptyDraft(defaults)
  return { target: 'new', prospect: null, baseline: draft, draft, session: nextSession(), editing: [] }
}

// Unsaved input kept from before (draftStorage.ts): put back in the form, or — when the prospect changed since it was
// typed — offered to the person.
type Recovery = 'restored' | { stale: KeptDraft } | null

interface Opened {
  forms: Forms
  recovery: Recovery
}

// A form just opened, with the input kept for it (nothing when the server already holds the same values). `offer`:
// never put it back unasked.
function recovered(fresh: Forms, offer = false): Opened {
  const kept = keptDraft(fresh.target)
  if (!kept || !isDirty(kept.draft, fresh.baseline, fresh.prospect === null)) return { forms: fresh, recovery: null }
  if (offer || kept.version !== (fresh.prospect?.version ?? null)) return { forms: fresh, recovery: { stale: kept } }
  return { forms: { ...fresh, draft: kept.draft, editing: kept.editing }, recovery: 'restored' }
}

// The Prospect editor (Task 15): one wide drawer for adding and editing a person, opened by the Prospection list
// (contract: prospection/prospectEditor.tsx). Prefilled; what needs verification is shown in warning style; one
// atomic save; « Enregistrer et suivant » follows the list's queue. Ctrl+S saves, Ctrl+Entrée saves and moves on,
// Échap closes (asking first when changes are pending).
export function ProspectEditor({ target, queue, onNavigate }: ProspectEditorProps) {
  const navigate = useNavigate()
  const loaded = useProspect(target === 'new' ? null : target)
  const [opened] = useState<Opened | null>(() => (target === 'new' ? recovered(newForms()) : null))
  const [forms, setForms] = useState<Forms | null>(opened?.forms ?? null)
  const [recovery, setRecovery] = useState<Recovery>(opened?.recovery ?? null)
  const [shownTarget, setShownTarget] = useState(target)
  const [submitted, setSubmitted] = useState(false)
  const [refusal, setRefusal] = useState<ProspectRefusal | null>(null)
  const [notice, setNotice] = useState<Notice | null>(null)
  const [confirm, setConfirm] = useState<{ action: () => void; label: string } | null>(null)
  const [deleting, setDeleting] = useState(false)
  const [moving, setMoving] = useState(false)
  // The open tab: Profil whenever another prospect (or a fresh form) is shown; kept while the same one is saved.
  const [tab, setTab] = useState<EditorTab>('profile')
  // « Voir la note » of the score detail: the note the Suivi tab must show and focus (ProspectNotes clears it once done).
  const [noteToShow, setNoteToShow] = useState<string | null>(null)
  // Context-menu requests (« Lier à… », « Mission »): a counter each, read by the Relations card / the Mission button.
  const [linkRequest, setLinkRequest] = useState(0)
  const [missionRequest, setMissionRequest] = useState(0)
  // « Changer de statut » / « Archiver »: the dialog open over the sheet.
  const [lifecycle, setLifecycle] = useState<'status' | 'archive' | null>(null)
  // `?section=emails` (a list's « Modifier les e-mails »): the sheet opens on the addresses, as inputs. Once.
  const [emailsAsked, setEmailsAsked] = useState(false)
  const location = useLocation()
  const wantsEmails = new URLSearchParams(location.search).get('section') === 'emails'

  // Another person (Save & Next, Back/Forward): drop the previous one's form and messages — unless the form already
  // shows it (a prospect just created here).
  if (shownTarget !== target) {
    setShownTarget(target)
    if (forms?.target !== target) {
      const fresh = target === 'new' ? recovered(newForms()) : null
      setForms(fresh?.forms ?? null)
      setRecovery(fresh?.recovery ?? null)
      setSubmitted(false)
      setRefusal(null)
      setNotice(null)
      setTab('profile')
    }
  }
  if (forms === null && loaded.data?.id === target) {
    const fresh = recovered(loadedForms(loaded.data))
    setForms(fresh.forms)
    setRecovery(fresh.recovery)
  }

  const formId = useId()
  const fieldId = (path: string) => `${formId}-${path}`
  const openEmails = wantsEmails && !emailsAsked && Boolean(forms?.prospect)
  if (openEmails && forms) {
    setEmailsAsked(true)
    setForms({ ...forms, editing: [...new Set<EditableSection>([...forms.editing, 'emails', 'phones'])] })
  }
  const formRef = useRef<HTMLFormElement>(null)
  const firstFieldRef = useRef<HTMLInputElement>(null)
  // A field to focus once the tab and section that hold it are shown (see `reveal`).
  const pendingFocus = useRef<string | null>(null)
  const mutations = useProspectMutations()
  const saving = mutations.create.isPending || mutations.update.isPending || moving

  const prospect = forms?.prospect ?? null
  // Read from the query when it shows this person: a confirmation removes a doubt without reopening the form.
  const identityDoubts = (loaded.data && loaded.data.id === prospect?.id ? loaded.data : prospect)?.emails.flatMap(
    (email) => (email.identity_doubt ? [email.identity_doubt] : []),
  ) ?? []
  const doubtful = new Set(identityDoubts.map((doubt) => doubt.address))
  // The score as it stands now: the query's (an evaluation writes the new score there), else the loaded prospect's.
  const liveScore = prospect ? (loaded.data?.id === prospect.id ? loaded.data.score : prospect.score) : null
  const isNew = forms !== null && prospect === null
  // For a prospect the server has not described yet, today in Circoe's business time zone.
  const today = prospect?.today ?? businessToday()
  const draft = forms?.draft
  const companyMoved = forms !== null && prospect !== null && forms.draft.company_id !== forms.baseline.company_id
  const company = useCompany(draft?.company_id ?? null)
  // Slots of the indicator strip (indicatorSources seam): the fiche state from the prospect's read model, the proximity
  // score from its endpoint.
  const completeness = useCompletenessIndicator(prospect)
  const proximity = useProximityIndicator(prospect?.id ?? null)
  const labels = useEmploymentLabels(draft, prospect)
  // The sheet's actions, shared by the right-click menu and the header's « … » menu.
  const sheetMenu = useSheetMenu({
    prospectId: prospect?.id ?? '',
    companyId: prospect?.company?.id ?? null,
    guard: guarded,
    onLink: () => {
      setTab('profile')
      setLinkRequest((count) => count + 1)
    },
    onMission: () => {
      setMissionRequest((count) => count + 1)
    },
    onLifecycle: (intent) => {
      guarded(() => {
        setLifecycle(intent)
      }, 'Continuer sans enregistrer')
    },
  })
  const dirty = forms !== null && isDirty(forms.draft, forms.baseline, isNew)
  const errors = forms ? validate(forms.draft, { isNew, today }) : {}
  const shown = submitted ? { ...errors } : {}
  if (refusal?.field) shown[refusal.field] = refusal.message
  // What waits on the other tab: unsaved changes, or fields to correct (marked on the tab, never only by colour).
  const tabDirty = forms ? dirtyTabs(forms.draft, forms.baseline, isNew) : { profile: false, tracking: false }
  const tabInvalid = tabsWithErrors(shown)

  // Unsaved input outlives a reload of the page. A stale one waits for the person's choice before being dropped.
  const stale = recovery !== null && recovery !== 'restored' ? recovery.stale : null
  useEffect(() => {
    if (!forms) return
    if (dirty) keepDraft(forms.target, { version: forms.prospect?.version ?? null, draft: forms.draft, editing: forms.editing })
    else if (!stale) forgetDraft(forms.target)
  }, [forms, dirty, stale])

  const savingSince = mutations.update.isPending
    ? mutations.update.submittedAt
    : mutations.create.isPending
      ? mutations.create.submittedAt
      : null

  // A new form (or another person) puts the focus on its first field — or, when the identity reads as a summary, on
  // its « Modifier » button.
  useEffect(() => {
    if (!forms?.session) return
    const first = firstFieldRef.current ?? formRef.current?.querySelector<HTMLElement>('[data-edit-toggle]')
    first?.focus()
  }, [forms?.session])

  useEffect(() => {
    if (!emailsAsked) return
    // After the first field's own focus: the first address, or « Ajouter un e-mail » when there is none.
    const section = document.getElementById(fieldId('emails.0.address')) ?? formRef.current?.querySelector<HTMLElement>('[data-add-alias="emails"]')
    section?.focus()
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once, when the section opened
  }, [emailsAsked])

  useEffect(() => {
    const path = pendingFocus.current
    if (path === null) return
    pendingFocus.current = null
    document.getElementById(fieldId(path))?.focus()
  })

  // Shows a field that needs attention: its tab, its section as inputs, then the focus (after the render).
  function reveal(path: string) {
    const section = sectionOfField(path)
    setTab(tabOfField(path))
    if (section) {
      setForms((current) => current && (current.editing.includes(section) ? current : { ...current, editing: [...current.editing, section] }))
    }
    pendingFocus.current = path
  }

  const editingNow = (section: EditableSection) => isNew || (forms?.editing.includes(section) ?? false)
  // One « Modifier » for one or several Profil sections (Coordonnées covers the e-mails and the phones).
  const sectionEdit = (...sections: EditableSection[]): SectionEdit => ({
    editing: sections.some(editingNow),
    locked: isNew,
    canDone: !Object.keys(errors).some((path) => {
      const found = sectionOfField(path)
      return found !== null && sections.includes(found)
    }),
    onEdit: () => {
      setForms((current) => current && { ...current, editing: [...current.editing.filter((open) => !sections.includes(open)), ...sections] })
    },
    onDone: () => {
      setForms((current) => current && { ...current, editing: current.editing.filter((open) => !sections.includes(open)) })
    },
  })

  function change(patch: Partial<ProspectDraft>) {
    setForms((current) => current && { ...current, draft: { ...current.draft, ...patch } })
    setRefusal((current) => (current?.conflict ? current : null))
    setNotice(null)
    if (stale) setRecovery(null)
  }

  function guarded(action: () => void, label: string) {
    if (dirty) setConfirm({ action, label })
    else action()
  }

  function revert() {
    setForms((current) => current && { ...current, draft: current.baseline, editing: sectionsWithErrors(validate(current.baseline, { isNew, today })) })
    setSubmitted(false)
    setRefusal(null)
    setRecovery(null)
  }

  // Saves the form; resolves to the saved prospect, or null when the form or the server refused it.
  async function save(): Promise<Prospect | null> {
    if (!forms || saving) return null
    if (!dirty) return forms.prospect
    setSubmitted(true)
    const invalid = Object.keys(validate(forms.draft, { isNew, today }))[0]
    if (invalid) {
      reveal(invalid)
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
      forgetDraft(forms.target)
      setRecovery(null)
      setSubmitted(false)
      setRefusal(null)
      return saved
    } catch (error) {
      const indexes = { emails: payloadIndexes(forms.draft.emails), phones: payloadIndexes(forms.draft.phones) }
      const refused = prospectRefusal(error, indexes)
      setRefusal(refused)
      if (refused.field) reveal(refused.field)
      return null
    }
  }

  async function saveOnly() {
    if (!dirty) return
    const creating = isNew
    const saved = await save()
    if (!saved) return
    setForms(loadedForms(saved, creating ? nextSession() : forms.session))
    const stale = (saved as ProspectSaved).unvalidated_messages ?? 0
    setNotice(stale > 0 ? `saved:${String(stale)}` as Notice : 'saved')
    if (creating) onNavigate(saved.id)
  }

  // « Enregistrer et fermer »: save, then close the sheet (a refused save keeps it open with its message).
  async function saveAndClose() {
    const saved = await save()
    if (saved) onNavigate(null)
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

  // After a « Séquence de contact » or alert operation: the prospect's new version, state and derived contact.
  async function syncFromServer() {
    const result = await loaded.refetch()
    const data = result.data
    if (data) setForms((current) => (current?.target === data.id ? withServerProspect(current, data) : current))
  }

  async function reload() {
    const result = await loaded.refetch()
    if (result.data) {
      // « Recharger la fiche » shows the server's values; what was typed stays one click away.
      const fresh = recovered(loadedForms(result.data), true)
      setForms(fresh.forms)
      setRecovery(fresh.recovery)
    }
    setSubmitted(false)
    setRefusal(null)
  }

  // The arrows: the previous or next prospect of the list's queue, asking first when changes are pending.
  async function step(direction: 'previous' | 'next') {
    if (!prospect || moving) return
    setMoving(true)
    try {
      const found = await queue[direction](prospect.id)
      if (found) onNavigate(found.id, { page: found.page })
      else setNotice('end')
    } catch {
      setRefusal({ field: null, message: 'Le prospect n’a pas pu être chargé. Réessayez.' })
    } finally {
      setMoving(false)
    }
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
  // The header follows the form (what is typed), like the cards: the saved name until there is a draft.
  const name = draft
    ? [civilityLabel(draft.civility || null), draft.first_name.trim(), draft.last_name.trim()].filter(Boolean).join(' ')
    : prospect
      ? [civilityLabel(prospect.civility), personName(prospect)].filter(Boolean).join(' ')
      : ''
  const block = prospect?.lifecycle.block ?? null
  const doNotContactReason =
    prospect?.contactability_status === 'do_not_contact'
      ? `Ne pas contacter${prospect.do_not_contact_reason ? ` : ${prospect.do_not_contact_reason}` : ''}`
      : block
        ? BLOCK_LABELS[block]
        : null
  const position = prospect ? queue.position(prospect.id) : null
  const queueText = position ? `Prospect ${String(position)} sur ${String(queue.total)} · ${selectionShortLabel(queue.criteria)}` : null
  const title = isNew ? 'Nouveau prospect' : name || 'Prospect'

  const sheetForm =
    forms !== null && draft !== undefined ? (
    <form
      id={formId}
      ref={formRef}
      className="prospect-editor-form"
      noValidate
      onSubmit={(event) => {
        event.preventDefault()
        void saveOnly()
      }}
    >
      {prospect && (prospect.lifecycle.block !== null || prospect.lifecycle.holds.length > 0) && (
        <section className="lifecycle-banner" aria-label="Hors prospection">
          <LifecycleSummary state={prospect.lifecycle} />
          <Button size="sm" onClick={() => { sheetMenu.actions.lifecycle?.('status') }}>
            Modifier
          </Button>
        </section>
      )}
      <Tabs
        label="Sections de la fiche"
        selected={tab}
        onSelect={setTab}
        tabs={[
          { id: 'profile', label: 'Profil', extra: <TabMark tab="profile" selected={tab} dirty={tabDirty} invalid={tabInvalid} /> },
          { id: 'tracking', label: 'Suivi', extra: <TabMark tab="tracking" selected={tab} dirty={tabDirty} invalid={tabInvalid} /> },
        ]}
      >
        {/* Both panels stay mounted (hidden when inactive): typed notes, the open sections and every field survive a tab change. */}
        <div className="prospect-editor" hidden={tab !== 'profile'}>
          {prospect !== null && (
            <ProspectIndicatorStrip
              score={
                <ProspectScoreCard
                  score={liveScore}
                  outdated={loaded.isRefetchError}
                  prospectId={prospect.id}
                  onShowNote={(noteId) => {
                    setTab('tracking')
                    setNoteToShow(noteId)
                  }}
                />
              }
              completeness={completeness}
              proximity={proximity}
            />
          )}
          <ProfileRow columns="two">
            {prospect !== null && (
              <ProfileSummary
                draft={draft}
                prospect={prospect}
                score={liveScore}
                labels={labels}
                completeness={completeness}
                proximity={proximity}
                companyMoved={companyMoved}
                today={today}
              />
            )}
            <EditorSection title="Coordonnées" icon={PhoneIcon} edit={sectionEdit('emails', 'phones')}>
              {prospect && <IdentityNotice prospectId={prospect.id} doubts={identityDoubts} />}
              {(['emails', 'phones'] as const).map((kind) => (
                <AliasList
                  key={kind}
                  nested
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
                  doubtful={kind === 'emails' ? doubtful : undefined}
                  edit={sectionEdit('emails', 'phones')}
                />
              ))}
            </EditorSection>
          </ProfileRow>
          <ProfileRow columns="three">
            <IdentitySection
              draft={draft}
              errors={shown}
              fieldId={fieldId}
              onChange={change}
              firstFieldRef={firstFieldRef}
              edit={sectionEdit('identity')}
            />
            <EmploymentSection
              draft={draft}
              errors={shown}
              fieldId={fieldId}
              onChange={change}
              prospect={prospect}
              companyMoved={companyMoved}
              labels={labels}
              edit={sectionEdit('employment')}
            />
            <CompanySection companyId={draft.company_id} />
          </ProfileRow>
          {prospect && (
            <ProfileRow columns="one">
              <ProspectLinksCard
                prospectId={prospect.id}
                addRequest={linkRequest}
                onOpenGraph={() => {
                  guarded(() => void navigate(prospectGraphHref(prospect.id)), 'Ouvrir le graphe sans enregistrer')
                }}
              />
            </ProfileRow>
          )}
        </div>
        <div className="prospect-editor" hidden={tab !== 'tracking'}>
          <TrackingTab
            draft={draft}
            errors={shown}
            fieldId={fieldId}
            onChange={change}
            prospect={prospect}
            dirty={dirty}
            today={today}
            noteToShow={noteToShow}
            onNoteShown={() => {
              setNoteToShow(null)
            }}
            onChanged={() => void syncFromServer()}
          />
        </div>
      </Tabs>
    </form>
    ) : null

  const mainEmail = draft ? mainAlias(draft.emails).alias?.value.trim() : undefined
  const job = [labels.role ?? draft?.exact_job_title.trim(), labels.company].filter(Boolean).join(' · ')
  const personInitials = initials([draft?.first_name, draft?.last_name].filter(Boolean).join(' ').trim())

  return (
    <Modal
      open
      sheet
      size="xl"
      title={title}
      onClose={() => {
        guarded(close, 'Fermer sans enregistrer')
      }}
      heading={(titleId) => (
        <div className="sheet-head">
          <span className="sheet-head__avatar" aria-hidden="true">
            {isNew || !personInitials ? <UserPlusIcon size={26} /> : personInitials}
          </span>
          <div className="sheet-head__text">
            <h2 id={titleId} className="sheet-head__name" title={title}>
              {title}
            </h2>
            {isNew ? (
              <p className="sheet-head__meta">Saisie manuelle : la provenance est enregistrée avec la fiche.</p>
            ) : forms ? (
              <p className="sheet-head__meta">
                <span className="sheet-head__job" title={job || undefined}>
                  {job || <span className="prospect-editor__muted">Entreprise et rôle non renseignés</span>}
                </span>
                {mainEmail && (
                  <>
                    <span className="sheet-head__sep" aria-hidden="true" />
                    <span className="sheet-head__email" title={mainEmail}>
                      {mainEmail}
                    </span>
                  </>
                )}
              </p>
            ) : null}
          </div>
        </div>
      )}
      headerActions={
        prospect && (
          <>
            <ProspectMissionMenu
              openRequest={missionRequest}
              prospect={{
                id: prospect.id,
                firstName: prospect.first_name,
                lastName: prospect.last_name,
                roleLabel: labels.role,
                companyId: prospect.company?.id ?? null,
                companyName: prospect.company?.display_name ?? null,
              }}
            />
            <Button
              icon={PauseIcon}
              aria-haspopup="dialog"
              onClick={() => {
                sheetMenu.actions.lifecycle?.('status')
              }}
            >
              Statut
            </Button>
            <ProspectContactButton prospectId={prospect.id} disabledReason={doNotContactReason} />
            <ProspectMoreMenu prospectId={prospect.id} disabledReason={doNotContactReason} actions={sheetMenu.actions} />
          </>
        )
      }
      footer={
        forms && (
          <div className="prospect-editor__bar">
            <div className="prospect-editor__bar-status" role="status" aria-label="Enregistrement de la fiche">
              <EditorStatus
                savingSince={savingSince}
                restored={recovery === 'restored'}
                stale={stale !== null}
                dirty={dirty}
                notice={notice}
                errorCount={submitted ? Object.keys(errors).length : 0}
                refusal={refusal}
                segment={selectionShortLabel(queue.criteria)}
              />
              {stale && (
                <>
                  <Button
                    size="sm"
                    onClick={() => {
                      setForms((current) => current && { ...current, draft: stale.draft, editing: stale.editing })
                      setRecovery('restored')
                    }}
                  >
                    Restaurer ma saisie
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => {
                      setRecovery(null)
                    }}
                  >
                    Ignorer
                  </Button>
                </>
              )}
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
            {dirty && <Button onClick={revert}>Annuler les modifications</Button>}
            <Button type="submit" form={formId} variant="primary" loading={mutations.update.isPending || mutations.create.isPending} disabled={!dirty}>
              Enregistrer
            </Button>
            <Button
              disabled={!dirty || saving}
              onClick={() => {
                void saveAndClose()
              }}
            >
              Enregistrer et fermer
            </Button>
            {prospect && (
              <div className="prospect-editor__arrows" role="group" aria-label="Parcourir les prospects">
                {queueText && <span className="prospect-editor__position">{queueText}</span>}
                <IconButton
                  icon={ChevronLeftIcon}
                  label="Prospect précédent"
                  disabled={saving || (position !== null && position <= 1)}
                  onClick={() => {
                    guarded(() => void step('previous'), 'Changer de prospect sans enregistrer')
                  }}
                />
                <IconButton
                  icon={ChevronRightIcon}
                  label="Prospect suivant"
                  disabled={saving || (position !== null && position >= queue.total)}
                  onClick={() => {
                    guarded(() => void step('next'), 'Changer de prospect sans enregistrer')
                  }}
                />
              </div>
            )}
          </div>
        )
      }
    >
      {forms === null || draft === undefined ? (
        <LoadState failed={loaded.isError} notFound={isNotFound(loaded.error)} onRetry={() => void loaded.refetch()} />
      ) : prospect ? (
        // Right click (or Shift+F10) on the sheet offers its actions; each one also has a visible button (header,
        // Relations, Score, Entreprise cards).
        <ProspectSheetMenu prospectId={prospect.id} disabledReason={doNotContactReason} menu={sheetMenu}>
          {sheetForm}
        </ProspectSheetMenu>
      ) : (
        sheetForm
      )}
      {lifecycle && prospect && (
        <LifecycleDialog
          subject={{ type: 'prospect', id: prospect.id, name }}
          intent={lifecycle}
          onChanged={() => void reload()}
          onClose={() => {
            setLifecycle(null)
          }}
        />
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
            mutations.remove.mutate(
              { id: prospect.id, version: prospect.version },
              {
                onSuccess: () => {
                  forgetDraft(prospect.id)
                  close()
                },
              },
            )
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
              <Button
                variant="danger"
                onClick={() => {
                  // Abandoned on purpose: nothing is kept, and the question does not stay over the next prospect.
                  if (forms) forgetDraft(forms.target)
                  revert()
                  setConfirm(null)
                  confirm.action()
                }}
              >
                {confirm.label}
              </Button>
            </>
          }
        >
          <p>Les modifications de cette fiche ne sont pas enregistrées : elles seront perdues.</p>
        </Modal>
      )}
    </Modal>
  )
}

interface TabMarkProps {
  tab: EditorTab
  selected: EditorTab
  dirty: Record<EditorTab, boolean>
  invalid: Record<EditorTab, boolean>
}

// A mark on an inactive tab that holds fields to correct (glyph) or unsaved changes (dot), with its text for screen
// readers: a change or an error never hides behind the tab that is not shown.
function TabMark({ tab, selected, dirty, invalid }: TabMarkProps) {
  if (tab === selected) return null
  if (invalid[tab]) {
    return (
      <span className="prospect-editor__tab-mark" data-state="invalid">
        <AlertIcon size={14} />
        <span className="visually-hidden">champs à corriger</span>
      </span>
    )
  }
  if (!dirty[tab]) return null
  return (
    <span className="prospect-editor__tab-mark" data-state="dirty">
      <span className="prospect-editor__dot" aria-hidden="true" />
      <span className="visually-hidden">modifications non enregistrées</span>
    </span>
  )
}

function isNotFound(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'status' in error && error.status === 404
}

// Seconds after which a wait shows its length, and offers to ask again.
const SHOW_ELAPSED_AFTER = 2
const OFFER_RETRY_AFTER = 8

function Loading({ onRetry }: { onRetry: () => void }) {
  const [startedAt] = useState(() => Date.now())
  const seconds = useElapsed(startedAt)
  return (
    <div className="prospect-editor__state">
      <SpinnerIcon size={18} className="btn__spinner" />
      <span role="status">Chargement du prospect…</span>
      {seconds >= SHOW_ELAPSED_AFTER && <span aria-hidden="true">{seconds} s</span>}
      {seconds >= OFFER_RETRY_AFTER && (
        <Button size="sm" onClick={onRetry}>
          Réessayer
        </Button>
      )}
    </div>
  )
}

function LoadState({ failed, notFound, onRetry }: { failed: boolean; notFound: boolean; onRetry: () => void }) {
  if (!failed) return <Loading onRetry={onRetry} />
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

function noticeText(notice: Notice, segment: string): string {
  if (notice === 'saved') return 'Prospect enregistré.'
  if (notice === 'created_next') return 'Prospect enregistré. Saisissez le suivant : l’entreprise est reprise.'
  if (notice === 'end') return `Fin de la liste « ${segment} » : aucun prospect après celui-ci.`
  const count = Number(notice.slice('saved:'.length))
  return `Prospect enregistré. Adresse changée : ${count > 1 ? `${String(count)} messages repassent` : '1 message repasse'} en brouillon, à revalider.`
}

interface EditorStatusProps {
  // When the running save was sent; null while none runs.
  savingSince: number | null
  restored: boolean
  stale: boolean
  dirty: boolean
  notice: Notice | null
  errorCount: number
  refusal: ProspectRefusal | null
  segment: string
}

function EditorStatus({ savingSince, restored, stale, dirty, notice, errorCount, refusal, segment }: EditorStatusProps) {
  const seconds = useElapsed(savingSince)
  if (savingSince !== null) {
    return (
      <span className="prospect-editor__status prospect-editor__status--info">
        <SpinnerIcon size={16} className="btn__spinner" />
        Enregistrement…
        {seconds >= SHOW_ELAPSED_AFTER && <span aria-hidden="true">{seconds} s</span>}
      </span>
    )
  }
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
  if (stale) {
    return (
      <span className="prospect-editor__status prospect-editor__status--dirty">
        <AlertIcon size={16} />
        Saisie non enregistrée, antérieure à la dernière modification de la fiche
      </span>
    )
  }
  if (dirty) {
    return (
      <span className="prospect-editor__status prospect-editor__status--dirty">
        <span className="prospect-editor__dot" aria-hidden="true" />
        {restored ? 'Saisie non enregistrée restaurée' : 'Modifications non enregistrées'}
      </span>
    )
  }
  if (notice) {
    return (
      <span className={`prospect-editor__status prospect-editor__status--${notice === 'end' ? 'info' : 'saved'}`}>
        {notice === 'end' ? <InfoIcon size={16} /> : <CheckCircleIcon size={16} />}
        {noticeText(notice, segment)}
      </span>
    )
  }
  return (
    <span className="prospect-editor__keys">
      <kbd>Ctrl</kbd>+<kbd>S</kbd> enregistrer · <kbd>Échap</kbd> fermer
    </span>
  )
}
