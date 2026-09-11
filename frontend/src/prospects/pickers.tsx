import type { ReactNode } from 'react'
import { useState } from 'react'

import { useCompanies, useCompany } from '../api/companies'
import { useTaxonomyValues } from '../api/settings'
import { useCompanyEditor } from '../companies/CompanyEditorProvider'
import { useDebouncedValue } from '../settings/shared'
import { Combobox, type ComboboxOption } from '../ui/Combobox'

// Pickers of the Prospect editor: the company (server search, creation through the Company editor) and the role
// (Settings values, a new role created with the prospect's save).

const COMPANY_OPTIONS = 20

interface CompanyPickerProps {
  id: string
  value: string | null
  // Label of the selected company before its record loads (the prospect's company summary).
  selectedLabel: string | null
  error?: ReactNode
  warning?: ReactNode
  onChange: (id: string | null) => void
}

// Searches every company by name on the server (a picker over the first ones only would miss existing companies and
// invite duplicates). « Créer l’entreprise « … » » opens the Company editor prefilled with the text; the company it
// saves is selected — its similar-companies check still warns before a duplicate is created.
export function CompanyPicker({ id, value, selectedLabel, error, warning, onChange }: CompanyPickerProps) {
  const openCompanyEditor = useCompanyEditor()
  const [typed, setTyped] = useState('')
  const search = useDebouncedValue(typed.trim(), 250)
  const results = useCompanies(search, 0, COMPANY_OPTIONS)
  const selected = useCompany(value)
  const options: ComboboxOption[] = (results.data?.items ?? []).map((company) => ({
    id: company.id,
    label: company.display_name,
    hint: [company.city, company.email_domain].filter(Boolean).join(' · ') || undefined,
  }))
  const label = selected.data?.display_name ?? selectedLabel
  if (value && label && !options.some((option) => option.id === value)) options.unshift({ id: value, label })
  const settled = search === typed.trim() && !results.isFetching
  return (
    <Combobox
      id={id}
      label="Entreprise"
      required
      placeholder="Rechercher une entreprise"
      hint="Recherche sur le nom ; créez-la si elle n’existe pas encore."
      options={options}
      status={results.isError ? 'error' : settled ? 'ready' : 'loading'}
      value={value}
      error={error}
      warning={warning}
      onChange={onChange}
      onQueryChange={setTyped}
      create={{
        label: (text) => `Créer l’entreprise « ${text} »`,
        run: (text) =>
          new Promise((resolve) => {
            openCompanyEditor('new', {
              initialName: text,
              onSaved: (company) => {
                resolve({ id: company.id, label: company.display_name })
              },
              onClosed: () => {
                resolve(null)
              },
            })
          }),
      }}
    />
  )
}

// Id of the role typed in the picker, created with the save.
export const NEW_ROLE = 'nouveau-role'

interface RolePickerProps {
  id: string
  roleId: string | null
  // A role to create with the save.
  roleLabel: string | null
  error?: ReactNode
  warning?: ReactNode
  onChange: (role: { role_id: string | null; role_label: string | null }) => void
}

// The normalized role (filters) — the exact job title keeps the person's own wording. A missing role is created with
// the prospect's save (same rules and audit as Paramètres), so a cancelled edit leaves no new value behind.
export function RolePicker({ id, roleId, roleLabel, error, warning, onChange }: RolePickerProps) {
  const roles = useTaxonomyValues('roles')
  const options: ComboboxOption[] = (roles.data ?? []).map((role) => ({ id: role.id, label: role.label, inactive: !role.active }))
  if (roleLabel) options.push({ id: NEW_ROLE, label: roleLabel, hint: 'Nouveau rôle' })
  return (
    <Combobox
      id={id}
      label="Rôle"
      placeholder="Choisir ou créer un rôle"
      hint={
        roleLabel
          ? `« ${roleLabel} » sera ajouté aux rôles à l’enregistrement, pour tous les prospects.`
          : 'Classification normalisée, utilisée par les filtres.'
      }
      options={options}
      status={roles.isError ? 'error' : roles.isPending ? 'loading' : 'ready'}
      value={roleLabel ? NEW_ROLE : roleId}
      error={error}
      warning={warning}
      onChange={(value) => {
        if (value !== NEW_ROLE) onChange({ role_id: value, role_label: null })
      }}
      create={{
        label: (text) => `Créer le rôle « ${text} »`,
        run: (text) => {
          const label = text.replace(/\s+/g, ' ').trim()
          onChange({ role_id: null, role_label: label })
          return Promise.resolve({ id: NEW_ROLE, label })
        },
      }}
    />
  )
}
