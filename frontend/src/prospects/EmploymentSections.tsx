import type { ReactNode, RefObject } from 'react'

import type { ActivityStatus } from '../api/prospection'
import type { Civility, Prospect } from '../api/prospects'
import { civilityLabel } from '../prospection/labels'
import { StatusBadge } from '../ui/Badge'
import { Button } from '../ui/Button'
import { SelectField, TextField } from '../ui/fields'
import { AlertIcon, CheckCircleIcon, UndoIcon } from '../ui/icons'
import { EditorSection, type SectionEdit } from './EditorSection'
import { CompanyPicker, RolePicker } from './pickers'
import type { EmploymentLabels } from './ProfileSummary'
import type { FieldMessages, ProspectDraft } from './prospectForm'
import { employmentNeedsCheck, employmentState } from './verification'

export interface SectionProps {
  draft: ProspectDraft
  errors: FieldMessages
  fieldId: (path: string) => string
  onChange: (patch: Partial<ProspectDraft>) => void
}

const IMPORTED_HINT = 'Importé, à confirmer'
const MOVED_HINT = 'Nouvelle entreprise, à confirmer'

// Read view of a section: label / value pairs on one compact grid (a missing value says so).
export function Facts({ facts }: { facts: { label: string; value: ReactNode }[] }) {
  return (
    <dl className="prospect-facts">
      {facts.map((fact) => (
        <div key={fact.label} className="prospect-facts__item">
          <dt>{fact.label}</dt>
          <dd>{fact.value ?? <span className="prospect-editor__muted">Non renseigné</span>}</dd>
        </div>
      ))}
    </dl>
  )
}

interface IdentityProps extends SectionProps {
  firstFieldRef: RefObject<HTMLInputElement | null>
  edit: SectionEdit
}

// Civility, first and last name: facts until edited, inputs while editing (same draft either way).
export function IdentitySection({ draft, errors, fieldId, onChange, firstFieldRef, edit }: IdentityProps) {
  return (
    <EditorSection title="Identité" edit={edit}>
      {edit.editing ? (
        <div className="prospect-editor__identity">
          <SelectField
            id={fieldId('civility')}
            label="Civilité"
            value={draft.civility}
            onChange={(event) => {
              onChange({ civility: event.target.value as Civility | '' })
            }}
          >
            <option value="">—</option>
            <option value="mr">M.</option>
            <option value="ms">Mme</option>
          </SelectField>
          <TextField
            id={fieldId('first_name')}
            ref={firstFieldRef}
            label="Prénom"
            autoComplete="off"
            value={draft.first_name}
            error={errors.first_name}
            onChange={(event) => {
              onChange({ first_name: event.target.value })
            }}
          />
          <TextField
            id={fieldId('last_name')}
            label="Nom"
            autoComplete="off"
            value={draft.last_name}
            error={errors.last_name}
            onChange={(event) => {
              onChange({ last_name: event.target.value })
            }}
          />
        </div>
      ) : (
        <Facts
          facts={[
            { label: 'Civilité', value: civilityLabel(draft.civility || null) },
            { label: 'Prénom', value: draft.first_name.trim() || null },
            { label: 'Nom', value: draft.last_name.trim() || null },
          ]}
        />
      )}
    </EditorSection>
  )
}

const ACTIVITIES: { value: ActivityStatus; label: string }[] = [
  { value: 'active', label: 'Actif' },
  { value: 'inactive', label: 'Inactif' },
  { value: 'unknown', label: 'Inconnue' },
]

interface EmploymentProps extends SectionProps {
  prospect: Prospect | null
  companyMoved: boolean
  today: string
  labels: EmploymentLabels
  edit: SectionEdit
}

// Company, role, exact title and activity, then — on a secondary line — the employment verification they are covered by
// (state and its one-click actions). Imported values to confirm are flagged; an imported field left empty says what to
// do instead (there is nothing to confirm). Read as facts until edited.
export function EmploymentSection({ draft, errors, fieldId, onChange, prospect, companyMoved, today, labels, edit }: EmploymentProps) {
  const imported = employmentNeedsCheck({ prospect, draft, companyMoved: false })
  const warning = imported ? IMPORTED_HINT : undefined
  const flag = (filled: boolean, empty: string) =>
    imported && !filled ? { hint: empty } : { warning: filled ? warning : undefined }
  const activity = ACTIVITIES.find((candidate) => candidate.value === draft.activity_status)?.label ?? null
  return (
    <EditorSection title="Emploi" tone={companyMoved || imported ? 'warning' : undefined} edit={edit}>
      {companyMoved && (
        <div className="prospect-editor__banner" role="note">
          <AlertIcon size={18} />
          <p>
            <strong>Entreprise modifiée.</strong> À l’enregistrement, la vérification de l’emploi est effacée et les
            e-mails et téléphones vérifiés repassent « à revérifier » ; ils sont conservés, rien n’est supprimé.
          </p>
        </div>
      )}
      {edit.editing ? (
        <div className="prospect-editor__grid">
          <CompanyPicker
            id={fieldId('company_id')}
            value={draft.company_id}
            selectedLabel={prospect?.company && prospect.company.id === draft.company_id ? prospect.company.display_name : null}
            error={errors.company_id}
            {...(companyMoved
              ? { warning: MOVED_HINT }
              : flag(draft.company_id !== null, 'Aucune entreprise — choisissez-la ou créez-la.'))}
            onChange={(company_id) => {
              onChange({ company_id })
            }}
          />
          <RolePicker
            id={fieldId('role_id')}
            roleId={draft.role_id}
            roleLabel={draft.role_label}
            error={errors.role_id}
            {...flag(draft.role_id !== null || draft.role_label !== null, 'Aucun rôle — choisissez-en un ou créez-le.')}
            onChange={onChange}
          />
          <div className="prospect-editor__wide">
            <TextField
              id={fieldId('exact_job_title')}
              label="Intitulé exact"
              placeholder="Le libellé de poste tel que la personne l’emploie"
              value={draft.exact_job_title}
              error={errors.exact_job_title}
              {...flag(draft.exact_job_title.trim() !== '', 'Aucun intitulé — saisissez le libellé de poste de la personne.')}
              onChange={(event) => {
                onChange({ exact_job_title: event.target.value })
              }}
            />
          </div>
          <fieldset className="prospect-segmented prospect-editor__wide" data-warning={warning ? '' : undefined}>
            <legend className="field__label">Activité</legend>
            <div className="prospect-segmented__options">
              {ACTIVITIES.map((candidate) => (
                <label key={candidate.value} className="prospect-segmented__option">
                  <input
                    type="radio"
                    name={fieldId('activity_status')}
                    value={candidate.value}
                    checked={draft.activity_status === candidate.value}
                    onChange={() => {
                      onChange({ activity_status: candidate.value })
                    }}
                  />
                  {candidate.label}
                </label>
              ))}
            </div>
            <p className="field__hint">En poste, parti, ou pas encore déterminé.</p>
          </fieldset>
        </div>
      ) : (
        <Facts
          facts={[
            { label: 'Entreprise', value: labels.company },
            { label: 'Rôle', value: labels.role },
            { label: 'Intitulé exact', value: draft.exact_job_title.trim() || null },
            { label: 'Activité', value: activity },
          ]}
        />
      )}
      <EmploymentVerification
        draft={draft}
        errors={errors}
        fieldId={fieldId}
        onChange={onChange}
        prospect={prospect}
        companyMoved={companyMoved}
        today={today}
        editing={edit.editing}
      />
    </EditorSection>
  )
}

interface VerificationProps extends SectionProps {
  prospect: Prospect | null
  companyMoved: boolean
  today: string
  // The section shows its inputs: the « vérifié le » date is offered next to the one-click action.
  editing: boolean
}

// Employment verification, on the Emploi section's secondary line (Decision D-UX3: no card of its own): the state, one
// click for « verified today », a past date while editing, or clearing. Data and API are unchanged.
function EmploymentVerification({ draft, errors, fieldId, onChange, prospect, companyMoved, today, editing }: VerificationProps) {
  const state = employmentState({ prospect, draft, companyMoved })
  const { action, day } = draft.verification
  const stored = prospect?.employment_verified_at && !companyMoved
  return (
    <div className="prospect-verify" role="group" aria-label="Vérification de l’emploi">
      <StatusBadge tone={state.tone} icon={state.icon}>
        {state.text}
      </StatusBadge>
      <Button
        size="sm"
        icon={CheckCircleIcon}
        variant={action === 'verified_now' ? 'primary' : 'secondary'}
        aria-pressed={action === 'verified_now'}
        onClick={() => {
          onChange({ verification: { action: 'verified_now', day: '' } })
        }}
      >
        Vérifié aujourd’hui
      </Button>
      {editing && (
        <TextField
          id={fieldId('employment_verification.day')}
          type="date"
          label="ou vérifié le"
          max={today}
          value={action === 'verified_on' ? day : ''}
          error={errors['employment_verification.day']}
          onChange={(event) => {
            const value = event.target.value
            onChange({ verification: { action: value ? 'verified_on' : 'keep', day: value } })
          }}
        />
      )}
      {stored && action === 'keep' && (
        <Button
          variant="ghost"
          size="sm"
          onClick={() => {
            onChange({ verification: { action: 'clear', day: '' } })
          }}
        >
          Effacer la vérification
        </Button>
      )}
      {action !== 'keep' && (
        <Button
          variant="ghost"
          size="sm"
          icon={UndoIcon}
          onClick={() => {
            onChange({ verification: { action: 'keep', day: '' } })
          }}
        >
          Annuler
        </Button>
      )}
      {editing && (
        <p className="prospect-editor__muted prospect-verify__scope">
          Couvre l’entreprise, le rôle, l’intitulé et l’activité ; e-mails et téléphones ont leur propre vérification.
        </p>
      )}
    </div>
  )
}
