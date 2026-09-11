import { useEffect, useRef, useState } from 'react'

import type { ChannelVerification } from '../api/prospection'
import type { PhoneType } from '../api/prospects'
import { StatusBadge } from '../ui/Badge'
import { Button, IconButton } from '../ui/Button'
import { SelectField, TextField } from '../ui/fields'
import { AlertIcon, CheckCircleIcon, MoreIcon, PlusIcon, TrashIcon } from '../ui/icons'
import { Menu, type MenuItem } from '../ui/Menu'
import type { Point } from '../ui/floating'
import { EditorSection } from './EditorSection'
import {
  type AliasDraft,
  type AliasKind,
  effectiveStatus,
  emailDomain,
  type FieldMessages,
  newAlias,
  suggestedPhoneType,
} from './prospectForm'
import { aliasState, originLabel, type StateLabel } from './verification'

const COPY = {
  emails: {
    title: 'E-mails',
    one: 'E-mail',
    field: 'address',
    label: 'Adresse e-mail',
    add: 'Ajouter un e-mail',
    empty: 'Aucune adresse. Ajoutez l’adresse professionnelle ; la première devient principale.',
  },
  phones: {
    title: 'Téléphones',
    one: 'Téléphone',
    field: 'number',
    label: 'Numéro',
    add: 'Ajouter un téléphone',
    empty: 'Aucun numéro. La première ligne ajoutée devient principale.',
  },
} as const

const PHONE_TYPES: Record<PhoneType, string> = { mobile: 'Mobile', landline: 'Fixe', other: 'Autre' }

const STATUS_ACTIONS: { status: ChannelVerification; label: string }[] = [
  { status: 'unverified', label: 'Marquer « non vérifié »' },
  { status: 'invalid', label: 'Marquer invalide' },
  { status: 'unknown', label: 'Marquer « statut inconnu »' },
]

interface AliasListProps {
  kind: AliasKind
  aliases: AliasDraft[]
  onChange: (aliases: AliasDraft[]) => void
  errors: FieldMessages
  fieldId: (path: string) => string
  companyMoved: boolean
  // The company's professional e-mail domain: an address elsewhere gets a warning.
  companyDomain: string | null
  today: string
  staleDays: number | null
}

// E-mail or phone aliases: add, edit, choose the primary one (radio), verify in one click, mark invalid/unknown,
// deactivate (a former address is kept) or remove an entry error. Exactly one active primary: the first active alias
// takes the flag when the primary one is removed or deactivated.
export function AliasList({ kind, aliases, onChange, errors, fieldId, companyMoved, companyDomain, today, staleDays }: AliasListProps) {
  const copy = COPY[kind]
  const addRef = useRef<HTMLButtonElement>(null)
  const pendingFocus = useRef<string | null>(null)
  const [menu, setMenu] = useState<{ index: number; at: Point } | null>(null)
  const menuAlias = menu ? aliases[menu.index] : undefined
  const context = { kind, companyMoved, today, staleDays }
  const toVerify = aliases.filter(
    (alias) => alias.is_active && alias.value.trim() && aliasState(alias, context).tone === 'warning',
  ).length
  const sectionState: StateLabel | null =
    toVerify > 0 ? { tone: 'warning', icon: AlertIcon, text: toVerify > 1 ? `${String(toVerify)} à vérifier` : '1 à vérifier' } : null

  useEffect(() => {
    if (pendingFocus.current === null) return
    const target = pendingFocus.current === 'add' ? addRef.current : document.getElementById(pendingFocus.current)
    pendingFocus.current = null
    target?.focus()
  })

  // The primary flag stays on an active alias: when none keeps it, the first active one takes it.
  function withPrimary(list: AliasDraft[]): AliasDraft[] {
    if (list.some((alias) => alias.is_primary && alias.is_active)) return list
    const first = list.findIndex((alias) => alias.is_active)
    return list.map((alias, index) => ({ ...alias, is_primary: index === first }))
  }

  function update(index: number, changes: Partial<AliasDraft>) {
    onChange(withPrimary(aliases.map((alias, position) => (position === index ? { ...alias, ...changes } : alias))))
  }

  function setValue(index: number, alias: AliasDraft, value: string) {
    const type = kind === 'phones' && !alias.typeChosen ? (suggestedPhoneType(value) ?? alias.type) : alias.type
    // A new value was never verified: a pending « Vérifié » no longer applies to it.
    update(index, { value, type, verified_now: false })
  }

  function add() {
    pendingFocus.current = fieldId(`${kind}.${String(aliases.length)}.${copy.field}`)
    onChange(withPrimary([...aliases, newAlias(kind, aliases.every((alias) => !alias.is_active))]))
  }

  function remove(index: number) {
    pendingFocus.current = 'add'
    onChange(withPrimary(aliases.filter((_, position) => position !== index)))
  }

  return (
    <EditorSection
      title={copy.title}
      count={aliases.filter((alias) => alias.stored || alias.value.trim()).length}
      state={sectionState}
    >
      {aliases.length === 0 && <p className="prospect-editor__muted">{copy.empty}</p>}
      <div className="prospect-aliases">
        {aliases.map((alias, index) => {
          const path = `${kind}.${String(index)}`
          const state = aliasState(alias, context)
          const title = `${copy.one} ${String(index + 1)}`
          const domain = kind === 'emails' ? emailDomain(alias.value) : null
          const otherDomain = companyDomain && alias.is_active && domain && domain !== companyDomain
          return (
            <fieldset
              key={alias.key}
              className="prospect-alias"
              data-primary={alias.is_primary ? '' : undefined}
              data-inactive={alias.is_active ? undefined : ''}
              data-tone={state.tone}
            >
              <legend className="visually-hidden">{title}</legend>
              <div className="prospect-alias__fields" data-kind={kind}>
                <TextField
                  id={fieldId(`${path}.${copy.field}`)}
                  label={copy.label}
                  type={kind === 'emails' ? 'email' : 'tel'}
                  autoComplete="off"
                  value={alias.value}
                  error={errors[`${path}.${copy.field}`]}
                  warning={
                    otherDomain ? `Domaine différent de celui de l’entreprise (${companyDomain}).` : undefined
                  }
                  onChange={(event) => {
                    setValue(index, alias, event.target.value)
                  }}
                />
                {kind === 'phones' && (
                  <SelectField
                    id={fieldId(`${path}.type`)}
                    label="Type"
                    value={alias.type}
                    onChange={(event) => {
                      update(index, { type: event.target.value as PhoneType, typeChosen: true })
                    }}
                  >
                    {Object.entries(PHONE_TYPES).map(([value, label]) => (
                      <option key={value} value={value}>
                        {label}
                      </option>
                    ))}
                  </SelectField>
                )}
                <label className="prospect-alias__primary">
                  <input
                    type="radio"
                    name={fieldId(`${kind}-primary`)}
                    checked={alias.is_primary}
                    disabled={!alias.is_active}
                    onChange={() => {
                      onChange(aliases.map((other, position) => ({ ...other, is_primary: position === index })))
                    }}
                  />
                  Principal
                </label>
              </div>
              <div className="prospect-alias__meta">
                <StatusBadge tone={state.tone} icon={state.icon}>
                  {state.text}
                </StatusBadge>
                <span className="prospect-alias__origin">{originLabel(kind, alias)}</span>
                <span className="prospect-alias__actions">
                  <Button
                    size="sm"
                    icon={CheckCircleIcon}
                    disabled={!alias.is_active || !alias.value.trim()}
                    aria-pressed={alias.verified_now}
                    onClick={() => {
                      update(index, { verified_now: !alias.verified_now })
                    }}
                  >
                    Vérifié
                  </Button>
                  <IconButton
                    icon={MoreIcon}
                    size="sm"
                    label={`Autres actions : ${title}`}
                    onClick={(event) => {
                      const rect = event.currentTarget.getBoundingClientRect()
                      setMenu({ index, at: { x: rect.right, y: rect.bottom + 4 } })
                    }}
                  />
                </span>
              </div>
              {!alias.stored && (
                <TextField
                  id={fieldId(`${path}.source_reference`)}
                  label="Source (facultatif)"
                  placeholder="ex. site de l’entreprise, signature d’e-mail"
                  value={alias.source_reference}
                  error={errors[`${path}.source_reference`]}
                  onChange={(event) => {
                    update(index, { source_reference: event.target.value })
                  }}
                />
              )}
            </fieldset>
          )
        })}
      </div>
      <div>
        <Button ref={addRef} icon={PlusIcon} size="sm" onClick={add}>
          {copy.add}
        </Button>
      </div>
      {menuAlias && menu && (
        <AliasMenu
          kind={kind}
          alias={menuAlias}
          label={`Actions : ${copy.one} ${String(menu.index + 1)}`}
          at={menu.at}
          companyMoved={companyMoved}
          onChange={(changes) => {
            update(menu.index, changes)
          }}
          onRemove={() => {
            remove(menu.index)
          }}
          onClose={() => {
            setMenu(null)
          }}
        />
      )}
    </EditorSection>
  )
}

interface AliasMenuProps {
  kind: AliasKind
  alias: AliasDraft
  label: string
  at: Point
  companyMoved: boolean
  onChange: (changes: Partial<AliasDraft>) => void
  onRemove: () => void
  onClose: () => void
}

// Less frequent actions of an alias: another verification status, deactivation (a former address or number is kept,
// struck through) and removal of an entry error.
function AliasMenu({ kind, alias, label, at, companyMoved, onChange, onRemove, onClose }: AliasMenuProps) {
  const status = effectiveStatus(kind, alias, companyMoved)
  const statuses = STATUS_ACTIONS.filter((action) => action.status !== status || alias.verified_now).map(
    (action): MenuItem => ({
      id: action.status,
      label: action.label,
      disabled: !alias.is_active,
      onSelect: () => {
        onChange({ verification_status: action.status, verified_now: false })
      },
    }),
  )
  const deactivate = kind === 'emails' ? 'Désactiver (ancienne adresse)' : 'Désactiver (ancien numéro)'
  const items: MenuItem[] = [
    ...statuses,
    {
      id: 'active',
      label: alias.is_active ? deactivate : 'Réactiver',
      onSelect: () => {
        onChange(alias.is_active ? { is_active: false, is_primary: false, verified_now: false } : { is_active: true })
      },
    },
    { id: 'remove', label: 'Retirer (erreur de saisie)', icon: TrashIcon, danger: true, onSelect: onRemove },
  ]
  return <Menu label={label} position={at} alignRight sections={[{ items }]} onClose={onClose} />
}
