import { type ReactNode, useState } from 'react'
import { useNavigate } from 'react-router'

import { ApiError } from '../api/client'
import { type MissionDetail, useCreateMission, useUpdateMission } from '../api/missions'
import { Button } from '../ui/Button'
import { Modal } from '../ui/Dialog'
import { TextAreaField, TextField } from '../ui/fields'
import { AlertIcon, ArrowRightIcon, BoltIcon, CheckCircleIcon, DatabaseIcon } from '../ui/icons'
import { InfoTip } from '../ui/InfoTip'
import { MissionCategoryPicker } from './MissionCategoryPicker'
import { MissionCompanies } from './MissionCompanies'
import { MissionExecutionSection } from './MissionExecutionSection'
import { MissionSkillsPanel } from './MissionSkillsPanel'
import { MissionSourcesPanel } from './MissionSourcesPanel'
import { type MissionDraft, type MissionFormApi, useMissionForm } from './useMissionForm'

interface MissionDialogProps {
  open: boolean
  onClose: () => void
  // « Modifier la mission »: the form starts from this mission and saves it in place. Mount the dialog when it
  // opens (the fields are initialised once).
  mission?: MissionDetail
  // Called after a successful edit (default: nothing more than closing).
  onSaved?: (detail: MissionDetail) => void
  // Pre-fills a new mission (initialised once, like `mission`).
  initialDraft?: MissionDraft
  // Voice dictation entry point. Rendered at the bottom-left of the footer with the form API
  // (`applyDraft` lays a draft over the fields, `toInput` reads what would be saved) and the form's own `submit`
  // (ordinary validation + save). Nothing is rendered when absent.
  assistantSlot?: (form: MissionFormApi, actions: { submit: () => void }) => ReactNode
}

// « + Nouvelle mission » / « Modifier la mission »: title, type (a compact field opening a picker that applies the
// category's defaults), consigne, execution (one-off or recurring + number of tasks), then two panels (« Skills »,
// « Sources »). Explanations live in InfoTips; only what blocks saving is stated in the form. State lives in `useMissionForm`; each section is its own component.
export function CreateMissionDialog({ open, onClose, mission, onSaved, initialDraft, assistantSlot }: MissionDialogProps) {
  const navigate = useNavigate()
  const create = useCreateMission()
  const update = useUpdateMission(mission?.card.id ?? '')
  const form = useMissionForm(mission, initialDraft)
  const { editing, category } = form
  const saving = editing ? update : create
  const [panel, setPanel] = useState<'skills' | 'sources' | null>(null)

  const submit = () => {
    const input = form.toInput()
    if (editing) {
      update.mutate(input, {
        onSuccess: (detail) => {
          onClose()
          onSaved?.(detail)
        },
      })
      return
    }
    create.mutate(input, {
      onSuccess: (detail) => {
        onClose()
        void navigate(`/missions/${detail.card.id}/resultat`)
      },
    })
  }

  const linked = form.contextRefs.length + (form.sourceIds?.length ?? 0)

  return (
    <Modal
      open={open}
      onClose={onClose}
      size="lg"
      title={editing ? 'Modifier la mission' : 'Créer mission'}
      titleIcon={<CheckCircleIcon size={34} />}
      className="dialog--mission"
      footer={
        <div className="mission-form__footer">
          <div className="mission-form__footer-start">{assistantSlot?.(form, { submit })}</div>
          <Button variant="secondary" onClick={onClose}>
            Annuler
          </Button>
          <Button
            variant="primary"
            disabled={!form.canSave || saving.isPending}
            loading={saving.isPending}
            onClick={submit}
          >
            {editing ? 'Enregistrer' : 'Créer la mission'}
            {!editing && <ArrowRightIcon size={18} />}
          </Button>
        </div>
      }
    >
      <div className="mission-form">
        <TextField
          label="Titre de la mission"
          value={form.name}
          onChange={(event) => {
            form.setName(event.target.value)
          }}
          placeholder="Ex. Veille salons logistiques"
          required
        />
        <MissionCategoryPicker form={form} />
        <div className="mission-form__tipped">
          <TextAreaField
            label="Consigne"
            value={form.promptOverride ?? ''}
            rows={4}
            onChange={(event) => {
              form.setPrompt(event.target.value)
            }}
            placeholder={category?.general_prompt ?? 'Saisir la consigne'}
          />
          <span className="mission-form__tip">
            <InfoTip label="Aide : consigne">
              {form.promptOverride === null
                ? category
                  ? `Laissée vide, la consigne générale de « ${category.name} » s’applique (texte grisé).`
                  : 'Laissée vide, la consigne générale de la catégorie s’applique.'
                : 'Consigne propre à cette mission ; videz le champ pour reprendre celle de la catégorie.'}
            </InfoTip>
          </span>
        </div>

        <MissionCompanies form={form} />

        <MissionExecutionSection form={form} />

        <div className="mission-form__panels" role="group" aria-label="Réglages de la mission">
          <button
            type="button"
            className="mission-form__panel-toggle"
            aria-expanded={panel === 'skills'}
            onClick={() => {
              setPanel(panel === 'skills' ? null : 'skills')
            }}
          >
            <BoltIcon size={24} /> Skills
          </button>
          <button
            type="button"
            className="mission-form__panel-toggle"
            aria-expanded={panel === 'sources'}
            onClick={() => {
              setPanel(panel === 'sources' ? null : 'sources')
            }}
          >
            <DatabaseIcon size={24} /> Sources
            {linked > 0 && <span className="mission-form__count">{linked}</span>}
          </button>
        </div>

        {panel === 'skills' && <MissionSkillsPanel form={form} />}
        {panel === 'sources' && <MissionSourcesPanel form={form} />}

        {!form.ready && form.missing && (
          <p className="mission-form__ready" role="status">
            <AlertIcon size={18} />
            {form.missing}
          </p>
        )}

        {saving.isError && (
          <p className="missions-error" role="alert">
            {saving.error instanceof ApiError
              ? saving.error.message
              : editing
                ? 'La mission n’a pas pu être enregistrée.'
                : 'La mission n’a pas pu être créée.'}
          </p>
        )}
      </div>
    </Modal>
  )
}
