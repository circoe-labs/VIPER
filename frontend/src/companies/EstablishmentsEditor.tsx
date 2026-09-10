import { useEffect, useRef } from 'react'

import { Badge } from '../ui/Badge'
import { Button, IconButton } from '../ui/Button'
import { TextField } from '../ui/fields'
import { PlusIcon, TrashIcon } from '../ui/icons'
import { type EstablishmentDraft, type FieldMessages, newEstablishment } from './companyForm'

// Suggestions only: `kind` is free text (data model: siège, agence, entrepôt…).
const KINDS = ['siège', 'agence', 'entrepôt', 'dépôt', 'plateforme logistique', 'usine']

type Field = Exclude<keyof EstablishmentDraft, 'key' | 'id' | 'is_primary'>

interface EstablishmentsEditorProps {
  establishments: EstablishmentDraft[]
  onChange: (establishments: EstablishmentDraft[]) => void
  // Messages keyed by API path (`establishments.1.siret`).
  errors: FieldMessages
  warnings: FieldMessages
  // DOM id of a field, so a save refusal can focus it.
  fieldId: (path: string) => string
  onBlur: (path: string, value: string) => void
}

export function establishmentTitle(row: EstablishmentDraft, index: number): string {
  return row.name.trim() || `Établissement ${String(index + 1)}`
}

// Repeater of a company's establishments: add, edit, remove, choose the primary one (radio group). The first
// establishment is primary until another is chosen; removing the primary one hands the flag to the first remaining.
export function EstablishmentsEditor({ establishments, onChange, errors, warnings, fieldId, onBlur }: EstablishmentsEditorProps) {
  const addRef = useRef<HTMLButtonElement>(null)
  // Where the focus goes after the list changed: a new establishment's first field, or the add button.
  const pendingFocus = useRef<string | null>(null)
  const kindsId = `${fieldId('establishments')}-kinds`

  useEffect(() => {
    if (pendingFocus.current === null) return
    const target = pendingFocus.current === 'add' ? addRef.current : document.getElementById(pendingFocus.current)
    pendingFocus.current = null
    target?.focus()
  })

  function update(index: number, changes: Partial<EstablishmentDraft>) {
    onChange(establishments.map((row, position) => (position === index ? { ...row, ...changes } : row)))
  }

  function setPrimary(index: number) {
    onChange(establishments.map((row, position) => ({ ...row, is_primary: position === index })))
  }

  function add() {
    const created = newEstablishment(establishments.length === 0)
    pendingFocus.current = fieldId(`establishments.${String(establishments.length)}.name`)
    onChange([...establishments, created])
  }

  function remove(index: number) {
    const rest = establishments.filter((_, position) => position !== index)
    const first = rest[0]
    if (first && !rest.some((row) => row.is_primary)) rest[0] = { ...first, is_primary: true }
    pendingFocus.current = 'add'
    onChange(rest)
  }

  function text(index: number, row: EstablishmentDraft, field: Field, label: string, extra: object = {}) {
    const path = `establishments.${String(index)}.${field}`
    return (
      <TextField
        id={fieldId(path)}
        label={label}
        value={row[field]}
        error={errors[path]}
        warning={warnings[path]}
        onChange={(event) => {
          update(index, { [field]: event.target.value })
        }}
        onBlur={(event) => {
          onBlur(path, event.target.value)
        }}
        {...extra}
      />
    )
  }

  return (
    <div className="establishments">
      {establishments.length === 0 && (
        <p className="company-editor__muted">
          Aucun établissement. Ajoutez le siège ou les sites connus ; le premier devient l’établissement principal.
        </p>
      )}
      <datalist id={kindsId}>
        {KINDS.map((kind) => (
          <option key={kind} value={kind} />
        ))}
      </datalist>
      {establishments.map((row, index) => {
        const title = establishmentTitle(row, index)
        return (
          <fieldset key={row.key} className="establishment-card" data-primary={row.is_primary ? '' : undefined}>
            <legend className="visually-hidden">{title}</legend>
            <div className="establishment-card__header" aria-hidden="true">
              <span className="establishment-card__title">{title}</span>
              {row.is_primary && <Badge tone="accent">Principal</Badge>}
            </div>
            <div className="establishment-card__actions">
              <label className="establishment-card__primary">
                <input
                  type="radio"
                  name={fieldId('establishments-primary')}
                  checked={row.is_primary}
                  onChange={() => {
                    setPrimary(index)
                  }}
                />
                Établissement principal
              </label>
              <IconButton
                icon={TrashIcon}
                size="sm"
                label={`Retirer « ${title} »`}
                onClick={() => {
                  remove(index)
                }}
              />
            </div>
            <div className="establishment-card__grid">
              {text(index, row, 'name', 'Nom de l’établissement')}
              {text(index, row, 'kind', 'Type', { list: kindsId, hint: 'Siège, agence, entrepôt…' })}
              {text(index, row, 'siret', 'SIRET', { inputMode: 'numeric', hint: '14 chiffres ; les espaces sont ignorés.' })}
              <div className="establishment-card__wide">{text(index, row, 'address_line1', 'Adresse')}</div>
              {text(index, row, 'address_line2', 'Complément d’adresse')}
              {text(index, row, 'postal_code', 'Code postal', { autoComplete: 'off' })}
              {text(index, row, 'city', 'Ville')}
              {text(index, row, 'country', 'Pays')}
            </div>
          </fieldset>
        )
      })}
      <div>
        <Button ref={addRef} icon={PlusIcon} size="sm" onClick={add}>
          Ajouter un établissement
        </Button>
      </div>
    </div>
  )
}
