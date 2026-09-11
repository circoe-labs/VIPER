import type { RefObject } from 'react'

import type { ActivityStatus } from '../api/prospection'
import type { Civility, Prospect } from '../api/prospects'
import { Button } from '../ui/Button'
import { SelectField, TextField } from '../ui/fields'
import { AlertIcon, CheckCircleIcon, UndoIcon } from '../ui/icons'
import { EditorSection } from './EditorSection'
import { CompanyPicker, RolePicker } from './pickers'
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

export function IdentitySection({ draft, errors, fieldId, onChange, firstFieldRef }: SectionProps & { firstFieldRef: RefObject<HTMLInputElement | null> }) {
  return (
    <EditorSection title="Identité">
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
}

// Company, role, exact title and activity: the employment context the verification date covers. Imported values to
// confirm are flagged; an imported field left empty says what to do instead (there is nothing to confirm).
export function EmploymentSection({ draft, errors, fieldId, onChange, prospect, companyMoved }: EmploymentProps) {
  const imported = employmentNeedsCheck({ prospect, draft, companyMoved: false })
  const warning = imported ? IMPORTED_HINT : undefined
  const flag = (filled: boolean, empty: string) =>
    imported && !filled ? { hint: empty } : { warning: filled ? warning : undefined }
  return (
    <EditorSection title="Emploi" tone={companyMoved || imported ? 'warning' : undefined}>
      {companyMoved && (
        <div className="prospect-editor__banner" role="note">
          <AlertIcon size={18} />
          <p>
            <strong>Entreprise modifiée.</strong> À l’enregistrement, la vérification de l’emploi est effacée et les
            e-mails et téléphones vérifiés repassent « à revérifier » ; ils sont conservés, rien n’est supprimé.
          </p>
        </div>
      )}
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
            {ACTIVITIES.map((activity) => (
              <label key={activity.value} className="prospect-segmented__option">
                <input
                  type="radio"
                  name={fieldId('activity_status')}
                  value={activity.value}
                  checked={draft.activity_status === activity.value}
                  onChange={() => {
                    onChange({ activity_status: activity.value })
                  }}
                />
                {activity.label}
              </label>
            ))}
          </div>
          <p className="field__hint">En poste, parti, ou pas encore déterminé.</p>
        </fieldset>
      </div>
    </EditorSection>
  )
}

interface VerificationProps extends SectionProps {
  prospect: Prospect | null
  companyMoved: boolean
  today: string
}

// Employment verification: one click for « verified today », a past date if it was checked earlier, or clearing.
export function VerificationSection({ draft, errors, fieldId, onChange, prospect, companyMoved, today }: VerificationProps) {
  const state = employmentState({ prospect, draft, companyMoved })
  const { action, day } = draft.verification
  const stored = prospect?.employment_verified_at && !companyMoved
  return (
    <EditorSection title="Vérification de l’emploi" state={state} tone={state.tone === 'warning' ? 'warning' : undefined}>
      <p className="prospect-editor__muted">
        Couvre l’entreprise, le rôle, l’intitulé et l’activité ; e-mails et téléphones ont leur propre vérification.
      </p>
      <div className="prospect-verify">
        <Button
          icon={CheckCircleIcon}
          variant={action === 'verified_now' ? 'primary' : 'secondary'}
          aria-pressed={action === 'verified_now'}
          onClick={() => {
            onChange({ verification: { action: 'verified_now', day: '' } })
          }}
        >
          Vérifié aujourd’hui
        </Button>
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
      </div>
    </EditorSection>
  )
}
