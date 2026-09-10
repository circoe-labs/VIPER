import type { ReactNode } from 'react'

import {
  referentName,
  type Referent,
  type TaxonomyKind,
  type TaxonomyValue,
  useReferentMutations,
  useReferents,
  useTaxonomyMutations,
  useTaxonomyValues,
} from '../api/settings'
import { Combobox, type ComboboxCreate, type ComboboxOption } from '../ui/Combobox'
import { settingsErrorMessage } from './messages'

// Pickers for the Settings values, for record editors (Company editor: segment + categories; Prospect editor: role,
// referent). They list active values, keep an inactive value visible only while it is selected, and create a missing
// value inline (« Créer « … » ») through the same audited Settings API — the "inline extensibility from forms" rule.

interface PickerProps {
  label: string
  hint?: ReactNode
  error?: ReactNode
  required?: boolean
  disabled?: boolean
  placeholder?: string
  // Offer « Créer « … » » for a text matching no value (default true).
  allowCreate?: boolean
}

function taxonomyOption(value: TaxonomyValue): ComboboxOption {
  return { id: value.id, label: value.label, inactive: !value.active }
}

function referentOption(referent: Referent): ComboboxOption {
  return { id: referent.id, label: referentName(referent), hint: referent.email ?? undefined, inactive: !referent.active }
}

function status(query: { isPending: boolean; isError: boolean }): 'ready' | 'loading' | 'error' {
  if (query.isError) return 'error'
  return query.isPending ? 'loading' : 'ready'
}

// Server refusals (duplicate typed differently, invalid text…) come back as the Error shown under the field.
async function explained<T>(action: Promise<T>): Promise<T> {
  try {
    return await action
  } catch (error) {
    throw new Error(settingsErrorMessage(error), { cause: error })
  }
}

function useTaxonomyPicker(kind: TaxonomyKind, allowCreate: boolean) {
  const values = useTaxonomyValues(kind)
  const { create } = useTaxonomyMutations(kind)
  const creation: ComboboxCreate | undefined = allowCreate
    ? { run: async (text) => taxonomyOption(await explained(create.mutateAsync(text))) }
    : undefined
  return { options: (values.data ?? []).map(taxonomyOption), status: status(values), create: creation }
}

export type TaxonomySelectProps = PickerProps & {
  kind: TaxonomyKind
  value: string | null
  onChange: (id: string | null) => void
}

// One value: a prospect's role, a company's commercial segment.
export function TaxonomySelect({ kind, allowCreate = true, ...props }: TaxonomySelectProps) {
  return <Combobox {...props} {...useTaxonomyPicker(kind, allowCreate)} />
}

export type TaxonomyMultiSelectProps = PickerProps & {
  kind: TaxonomyKind
  value: readonly string[]
  onChange: (ids: string[]) => void
}

// Several values: a company's activity categories.
export function TaxonomyMultiSelect({ kind, allowCreate = true, ...props }: TaxonomyMultiSelectProps) {
  return <Combobox multiple {...props} {...useTaxonomyPicker(kind, allowCreate)} />
}

// "Marie Durand" → first name "Marie", last name "Durand"; "Jean-Marc De La Test" → "Jean-Marc" / "De La Test".
export function splitFullName(text: string): { first_name: string; last_name: string } | null {
  const [first, ...rest] = text.trim().split(/\s+/)
  return first && rest.length > 0 ? { first_name: first, last_name: rest.join(' ') } : null
}

export type ReferentSelectProps = PickerProps & {
  value: string | null
  onChange: (id: string | null) => void
}

// A Circoe internal referent (never a login account). Inline creation takes "Prénom Nom"; the e-mail can be added in
// Paramètres afterwards.
export function ReferentSelect({ allowCreate = true, ...props }: ReferentSelectProps) {
  const referents = useReferents()
  const { create } = useReferentMutations()
  const creation: ComboboxCreate | undefined = allowCreate
    ? {
        label: (text) => `Créer le référent « ${text} »`,
        refuse: (text) => (splitFullName(text) ? null : 'Saisissez le prénom puis le nom pour créer un référent.'),
        run: async (text) => {
          const name = splitFullName(text)
          if (!name) throw new Error('Saisissez le prénom puis le nom pour créer un référent.')
          return referentOption(await explained(create.mutateAsync({ ...name, email: null })))
        },
      }
    : undefined
  return (
    <Combobox
      {...props}
      options={(referents.data ?? []).map(referentOption)}
      status={status(referents)}
      create={creation}
    />
  )
}
