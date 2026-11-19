import { type ReactNode, useState } from 'react'

import { type Integrations, type IntegrationsChanges, useIntegrationsMutations } from '../api/integrations'
import { useElapsed } from '../lib/useElapsed'
import { Button } from '../ui/Button'
import { SaveIcon, UndoIcon } from '../ui/icons'
import { fallbackText, type FormField, fromDraft, saveRefusal, sourceText, toDraft } from './integrationsModel'
import type { Feedback } from './shared'

// Config AI › Connexions: the form helpers every connection's panes share. Each pane saves its own fields (one primary
// button, in the dialog's footer); every field says where its value comes from and can go back to the default.

// The edited fields of one card (only what the person changed: untouched fields follow the server).
export function useCardForm(data: Integrations) {
  const [edits, setEdits] = useState<Partial<Record<FormField, string>>>({})
  const [errors, setErrors] = useState<Partial<Record<string, string>>>({})
  const value = (field: FormField) => edits[field] ?? toDraft(field, data.fields[field].value)
  return {
    value,
    errors,
    setErrors,
    edit(field: FormField, next: string) {
      setEdits((current) => ({ ...current, [field]: next }))
      setErrors((current) => ({ ...current, [field]: undefined }))
    },
    forget(fields: readonly FormField[]) {
      setEdits((current) =>
        Object.fromEntries(Object.entries(current).filter(([field]) => !(fields as readonly string[]).includes(field))),
      )
    },
    // The changed fields of `fields`, or the local errors (a number that is not one).
    changes(fields: readonly FormField[]): { changes: IntegrationsChanges; invalid: Partial<Record<string, string>> } {
      const changes: IntegrationsChanges = {}
      const invalid: Partial<Record<string, string>> = {}
      for (const field of fields) {
        const draft = edits[field]
        if (draft === undefined || draft === toDraft(field, data.fields[field].value)) continue
        const parsed = fromDraft(field, draft)
        if (parsed instanceof Error) invalid[field] = parsed.message
        else changes[field] = parsed
      }
      return { changes, invalid }
    },
  }
}

type CardForm = ReturnType<typeof useCardForm>

// Saves one card's changes; says the outcome in the card and puts a refused value's message under its field.
export function useCardSave(data: Integrations, form: CardForm) {
  const { save } = useIntegrationsMutations()
  const [feedback, setFeedback] = useState<Feedback | null>(null)
  const [startedAt, setStartedAt] = useState<number | null>(null)
  const elapsed = useElapsed(startedAt)

  // Answers the refused field (if any) on failure, null on success.
  async function submit(
    changes: IntegrationsChanges,
    success: string,
    clear: readonly FormField[],
  ): Promise<{ ok: boolean; field?: string }> {
    setFeedback(null)
    setStartedAt(Date.now())
    try {
      await save.mutateAsync({ version: data.version, changes })
      form.forget(clear)
      form.setErrors({})
      setFeedback({ tone: 'success', text: success })
      return { ok: true }
    } catch (error) {
      const refusal = saveRefusal(error)
      if (refusal.field) form.setErrors({ [refusal.field]: refusal.message })
      setFeedback({ tone: 'error', text: refusal.field ? 'Rien n’a été enregistré : corrigez le champ signalé.' : refusal.message })
      return { ok: false, field: refusal.field }
    } finally {
      setStartedAt(null)
    }
  }

  // `clearMutation`: forget the last request's variables (a typed key must not stay in memory, S8 QA m3).
  return { submit, feedback, saving: startedAt !== null, elapsed, clearMutation: save.reset }
}

// The « i » of a field: what it is for, then where its value comes from.
export function settingInfo(data: Integrations, field: FormField, help?: ReactNode) {
  return (
    <>
      {help}
      {help ? ' ' : null}
      {sourceText(data.fields[field])}
    </>
  )
}

interface ResetProps {
  data: Integrations
  field: FormField
  busy: boolean
  onReset: (field: FormField) => void
}

// Under a field: only « Rétablir », for a value set here.
export function ResetHint({ data, field, busy, onReset }: ResetProps) {
  const setting = data.fields[field]
  if (setting.source !== 'ui') return null
  return (
    <button
      type="button"
      className="settings-setting__reset"
      disabled={busy}
      title={`Rétablir la valeur par défaut : ${fallbackText(field, setting.fallback)}`}
      onClick={() => {
        onReset(field)
      }}
    >
      <UndoIcon size={14} />
      Rétablir
    </button>
  )
}

export function SaveButton({ saving, elapsed, disabled, variant = 'primary', children, onClick }: {
  saving: boolean
  elapsed: number
  disabled: boolean
  variant?: 'primary' | 'secondary'
  children: ReactNode
  onClick: () => void
}) {
  return (
    <Button variant={variant} icon={SaveIcon} loading={saving} disabled={disabled} onClick={onClick}>
      {saving ? `Enregistrement… ${String(elapsed)} s` : children}
    </Button>
  )
}
