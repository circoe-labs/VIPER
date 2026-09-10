import { type ReactNode, type RefObject, useEffect, useId, useRef, useState } from 'react'

import { type Company, useCompany, useCompanyMutations } from '../api/companies'
import { TaxonomyMultiSelect, TaxonomySelect } from '../settings/selectors'
import { Button } from '../ui/Button'
import { Drawer, Modal } from '../ui/Dialog'
import { TextAreaField, TextField } from '../ui/fields'
import { AlertIcon, CheckCircleIcon, TrashIcon } from '../ui/icons'
import {
  type CompanyDraft,
  draftFromCompany,
  emptyDraft,
  type FieldMessages,
  isDirty,
  suggestedEmailDomain,
  toInput,
  validate,
} from './companyForm'
import { DeleteCompanyDialog, ProspectsSection, Section, SimilarCompanies } from './CompanyEditorParts'
import { EstablishmentsEditor } from './EstablishmentsEditor'
import { type CompanyRefusal, companyRefusal } from './messages'
import './companies.css'

export interface CompanyEditorProps {
  // null: a new company.
  companyId: string | null
  // Prefilled display name of a new company (e.g. the text typed in a picker).
  initialName?: string
  onClose: () => void
  onSaved?: (company: Company) => void
  onDeleted?: (id: string) => void
  // Switch the editor to another, existing company (a similar one found while typing).
  onOpenCompany: (id: string) => void
}

interface Forms {
  // Last loaded or saved state; `draft` is what the user is typing.
  baseline: CompanyDraft
  draft: CompanyDraft
  company: Company | null
}

// Lightweight Company editor (Task 07), a wide drawer opened from anywhere through `useCompanyEditor`. Sections
// Identité, Classification, Établissements, Contexte Circoe, Prospects associés — not a CRM dossier (no deals, tasks or
// notes). Saving keeps the drawer open on the saved company; closing with unsaved changes asks first. Ctrl+S saves.
export function CompanyEditor({ companyId, initialName, onClose, onSaved, onDeleted, onOpenCompany }: CompanyEditorProps) {
  const loaded = useCompany(companyId)
  const [forms, setForms] = useState<Forms | null>(() =>
    companyId ? null : { baseline: emptyDraft(), draft: { ...emptyDraft(), display_name: initialName ?? '' }, company: null },
  )
  if (forms === null && loaded.data) {
    const draft = draftFromCompany(loaded.data)
    setForms({ baseline: draft, draft, company: loaded.data })
  }
  const formId = useId()
  const fieldId = (path: string) => `${formId}-${path}`
  const nameRef = useRef<HTMLInputElement>(null)
  const mutations = useCompanyMutations()
  const saving = mutations.create.isPending || mutations.update.isPending
  const [touched, setTouched] = useState<ReadonlySet<string>>(new Set())
  const [submitted, setSubmitted] = useState(false)
  const [refusal, setRefusal] = useState<CompanyRefusal | null>(null)
  const [savedNotice, setSavedNotice] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [confirm, setConfirm] = useState<{ action: () => void; label: string } | null>(null)

  const dirty = forms !== null && isDirty(forms.draft, forms.baseline)
  const validation = forms ? validate(forms.draft, forms.baseline) : { errors: {}, warnings: {} }
  // Errors show once a field was left or a save attempted; a server refusal shows on its field until the next edit.
  const shown: FieldMessages = {}
  for (const [field, message] of Object.entries(validation.errors)) {
    if (submitted || touched.has(field)) shown[field] = message
  }
  if (refusal?.field) shown[refusal.field] = refusal.message

  function guarded(action: () => void, label: string) {
    if (dirty) setConfirm({ action, label })
    else action()
  }

  function change(next: Partial<CompanyDraft>) {
    if (!forms) return
    setForms({ ...forms, draft: { ...forms.draft, ...next } })
    setRefusal(null)
    setSavedNotice(false)
  }

  // A field left with a value shows its errors from then on (an empty required field waits for the save attempt).
  function touch(field: string, value: string) {
    if (value.trim() && !touched.has(field)) setTouched(new Set(touched).add(field))
  }

  function revert() {
    if (forms) setForms({ ...forms, draft: forms.baseline })
    setRefusal(null)
    setSubmitted(false)
    setTouched(new Set())
  }

  async function save() {
    if (!forms || saving || !dirty) return
    setSubmitted(true)
    const firstInvalid = Object.keys(validation.errors)[0]
    if (firstInvalid) {
      document.getElementById(fieldId(firstInvalid))?.focus()
      return
    }
    try {
      const input = toInput(forms.draft)
      const saved = forms.company
        ? await mutations.update.mutateAsync({ id: forms.company.id, input })
        : await mutations.create.mutateAsync(input)
      const next = draftFromCompany(saved)
      setForms({ baseline: next, draft: next, company: saved })
      setSubmitted(false)
      setTouched(new Set())
      setSavedNotice(true)
      onSaved?.(saved)
    } catch (error) {
      const refused = companyRefusal(error)
      setRefusal(refused)
      if (refused.field) document.getElementById(fieldId(refused.field))?.focus()
    }
  }

  // Ctrl+S / ⌘S saves from anywhere in the editor (the drawer is modal).
  const saveRef = useRef(save)
  useEffect(() => {
    saveRef.current = save
  })
  useEffect(() => {
    function handle(event: KeyboardEvent) {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
        event.preventDefault()
        void saveRef.current()
      }
    }
    document.addEventListener('keydown', handle)
    return () => {
      document.removeEventListener('keydown', handle)
    }
  }, [])

  const company = forms?.company ?? null
  const errorCount = submitted ? Object.keys(validation.errors).length : 0

  return (
    <Drawer
      open
      size="xl"
      title={company?.display_name ?? (companyId ? 'Entreprise' : 'Nouvelle entreprise')}
      description="Fiche de contexte des prospects : identité, classification et établissements. Chaque enregistrement est tracé dans l’historique."
      initialFocusRef={nameRef}
      onClose={() => {
        guarded(onClose, 'Fermer sans enregistrer')
      }}
      footer={
        forms && (
          <div className="company-editor__bar">
            <div className="company-editor__bar-status" role="status">
              <EditorStatus dirty={dirty} saved={savedNotice} errorCount={errorCount} refusal={refusal} />
            </div>
            {company && (
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
            {dirty ? (
              <Button onClick={revert}>Annuler les modifications</Button>
            ) : (
              <Button onClick={onClose}>Fermer</Button>
            )}
            <Button type="submit" form={formId} variant="primary" loading={saving} disabled={!dirty}>
              Enregistrer
            </Button>
          </div>
        )
      }
    >
      {forms === null ? (
        <LoadState failed={loaded.isError} notFound={isNotFound(loaded.error)} onRetry={() => void loaded.refetch()} />
      ) : (
        <form
          id={formId}
          className="company-editor"
          noValidate
          onSubmit={(event) => {
            event.preventDefault()
            void save()
          }}
          // Enter in a one-line field saves (textareas keep their line breaks; an open picker handles Enter first).
          onKeyDown={(event) => {
            if (event.key === 'Enter' && event.target instanceof HTMLInputElement && !event.defaultPrevented) {
              event.preventDefault()
              void save()
            }
          }}
        >
          <CompanyFields
            draft={forms.draft}
            company={company}
            errors={shown}
            warnings={validation.warnings}
            fieldId={fieldId}
            nameRef={nameRef}
            onChange={change}
            onBlur={touch}
            onOpenCompany={(id) => {
              guarded(() => {
                onOpenCompany(id)
              }, 'Ouvrir sans enregistrer')
            }}
          />
        </form>
      )}
      {deleting && company && (
        <DeleteCompanyDialog
          company={company}
          onClose={() => {
            setDeleting(false)
          }}
          onDeleted={() => {
            onDeleted?.(company.id)
            onClose()
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
  if (!failed) return <p className="company-editor__state">Chargement de l’entreprise…</p>
  return (
    <div className="company-editor__state company-editor__state--error" role="alert">
      <AlertIcon size={18} />
      {notFound ? 'Cette entreprise n’existe plus : elle a peut-être été supprimée.' : 'Fiche indisponible.'}
      {!notFound && (
        <Button size="sm" onClick={onRetry}>
          Réessayer
        </Button>
      )}
    </div>
  )
}

function EditorStatus({
  dirty,
  saved,
  errorCount,
  refusal,
}: {
  dirty: boolean
  saved: boolean
  errorCount: number
  refusal: CompanyRefusal | null
}) {
  if (refusal) {
    return (
      <span className="company-editor__status company-editor__status--error">
        <AlertIcon size={16} />
        {refusal.field ? `Enregistrement impossible : ${refusal.message}` : refusal.message}
      </span>
    )
  }
  if (errorCount > 0) {
    return (
      <span className="company-editor__status company-editor__status--error">
        <AlertIcon size={16} />
        {errorCount > 1 ? `Corrigez les ${String(errorCount)} champs signalés.` : 'Corrigez le champ signalé.'}
      </span>
    )
  }
  if (dirty) {
    return (
      <span className="company-editor__status company-editor__status--dirty">
        <span className="company-editor__dot" aria-hidden="true" />
        Modifications non enregistrées
      </span>
    )
  }
  if (saved) {
    return (
      <span className="company-editor__status company-editor__status--saved">
        <CheckCircleIcon size={16} />
        Entreprise enregistrée.
      </span>
    )
  }
  return null
}

type TextName =
  | 'display_name'
  | 'legal_name'
  | 'siren'
  | 'website_url'
  | 'email_domain'
  | 'size_label'
  | 'project_done_with_circoe'
  | 'project_type'
  | 'circoe_references'
  | 'client_approach'

interface CompanyFieldsProps {
  draft: CompanyDraft
  company: Company | null
  errors: FieldMessages
  warnings: FieldMessages
  fieldId: (path: string) => string
  nameRef: RefObject<HTMLInputElement | null>
  onChange: (next: Partial<CompanyDraft>) => void
  onBlur: (field: string, value: string) => void
  onOpenCompany: (id: string) => void
}

function CompanyFields({ draft, company, errors, warnings, fieldId, nameRef, onChange, onBlur, onOpenCompany }: CompanyFieldsProps) {
  const suggestion = suggestedEmailDomain(draft)

  function text(field: TextName, label: string, extra: { hint?: ReactNode; required?: boolean; inputMode?: 'numeric' } = {}) {
    return (
      <TextField
        id={fieldId(field)}
        ref={field === 'display_name' ? nameRef : undefined}
        label={label}
        value={draft[field]}
        error={errors[field]}
        warning={warnings[field]}
        onChange={(event) => {
          onChange({ [field]: event.target.value })
        }}
        onBlur={(event) => {
          onBlur(field, event.target.value)
        }}
        {...extra}
      />
    )
  }

  function paragraph(field: TextName, label: string, hint?: string) {
    return (
      <TextAreaField
        id={fieldId(field)}
        label={label}
        hint={hint}
        rows={3}
        value={draft[field]}
        error={errors[field]}
        onChange={(event) => {
          onChange({ [field]: event.target.value })
        }}
      />
    )
  }

  return (
    <>
      <Section title="Identité">
        <div className="company-editor__grid">
          {text('display_name', 'Nom de l’entreprise', { required: true, hint: 'Nom usuel, affiché partout dans VIPER.' })}
          {text('legal_name', 'Raison sociale')}
          {text('siren', 'SIREN', { inputMode: 'numeric', hint: '9 chiffres ; les espaces sont ignorés.' })}
          {text('size_label', 'Taille', { hint: 'Texte libre, par exemple « 50-249 salariés ».' })}
          {text('website_url', 'Site web', { hint: 'https:// est ajouté si besoin.' })}
          <div className="company-editor__stack">
            {text('email_domain', 'Domaine e-mail', { hint: 'Domaine des adresses professionnelles, ex. exemple.fr.' })}
            {suggestion && (
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  onChange({ email_domain: suggestion })
                }}
              >
                Utiliser « {suggestion} », le domaine du site
              </Button>
            )}
          </div>
        </div>
        {!company && <SimilarCompanies draft={draft} onOpen={onOpenCompany} />}
      </Section>

      <Section title="Classification">
        <div className="company-editor__grid">
          <TaxonomySelect
            kind="commercial-segments"
            label="Segment commercial"
            placeholder="Choisir ou créer un segment"
            hint="Un seul segment par entreprise."
            value={draft.commercial_segment_id}
            error={errors.commercial_segment_id}
            onChange={(id) => {
              onChange({ commercial_segment_id: id })
            }}
          />
          <TaxonomyMultiSelect
            kind="activity-categories"
            label="Catégories d’activité"
            placeholder="Ajouter une catégorie"
            hint="Plusieurs possibles."
            value={draft.activity_category_ids}
            error={errors.activity_category_ids}
            onChange={(ids) => {
              onChange({ activity_category_ids: ids })
            }}
          />
        </div>
      </Section>

      <Section title="Établissements" count={draft.establishments.length}>
        <EstablishmentsEditor
          establishments={draft.establishments}
          onChange={(establishments) => {
            onChange({ establishments })
          }}
          errors={errors}
          warnings={warnings}
          fieldId={fieldId}
          onBlur={onBlur}
        />
      </Section>

      <Section title="Contexte Circoe">
        <div className="company-editor__grid">
          {paragraph('project_done_with_circoe', 'Projet déjà réalisé avec l’entreprise')}
          {paragraph('project_type', 'Type de projet')}
          {paragraph('circoe_references', 'Références Circoe', 'Fiches projets ou références citables.')}
          {paragraph('client_approach', 'Approche client')}
        </div>
      </Section>

      {company && <ProspectsSection company={company} />}
    </>
  )
}
