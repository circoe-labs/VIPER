import { useState } from 'react'

import { type Integrations, useIntegrations, useIntegrationsMutations } from '../api/integrations'
import { useElapsed } from '../lib/useElapsed'
import { Button } from '../ui/Button'
import { TextAreaField } from '../ui/fields'
import { AlertIcon, SaveIcon, SparklesIcon, UndoIcon } from '../ui/icons'
import { IntegrationCard } from './IntegrationCards'
import { saveRefusal, sourceText } from './integrationsModel'
import { type Feedback, FeedbackBanner } from './shared'

// Paramètres › Prompt initial: the brief the AI always receives before it drafts a Contact / R1 / R2 e-mail (what it is,
// who it writes to, why). The mandatory rules (facts only, format, booking link) and the client card follow it and are
// not editable. The text saved here replaces the built-in one; saving the built-in text unchanged (or « Rétablir »)
// goes back to it.
export function PromptSection() {
  const integrations = useIntegrations()
  if (integrations.isPending) return <p className="settings-state">Chargement…</p>
  if (integrations.isError) {
    return (
      <div className="settings-state settings-state--error" role="alert">
        <AlertIcon size={18} />
        Réglages du prompt indisponibles.
        <Button
          size="sm"
          onClick={() => {
            void integrations.refetch()
          }}
        >
          Réessayer
        </Button>
      </div>
    )
  }
  return <PromptCard data={integrations.data} />
}

function PromptCard({ data }: { data: Integrations }) {
  const { save } = useIntegrationsMutations()
  const setting = data.fields.contact_initial_prompt
  const saved = typeof setting.value === 'string' ? setting.value : data.initial_prompt_default
  const [edit, setEdit] = useState<string | null>(null)
  const [feedback, setFeedback] = useState<Feedback | null>(null)
  const [error, setError] = useState<string>()
  const [startedAt, setStartedAt] = useState<number | null>(null)
  const elapsed = useElapsed(startedAt)

  const draft = edit ?? saved
  const blank = draft.trim() === ''
  const dirty = draft.trim() !== saved.trim()
  const isDefault = draft.trim() === data.initial_prompt_default.trim()

  async function submit() {
    setFeedback(null)
    setError(undefined)
    setStartedAt(Date.now())
    try {
      // The built-in text is not stored: the setting goes back to following it.
      await save.mutateAsync({
        version: data.version,
        changes: { contact_initial_prompt: isDefault ? null : draft.trim() },
      })
      setEdit(null)
      setFeedback({
        tone: 'success',
        text: 'Prompt initial enregistré : il s’applique aux prochains mails générés.',
      })
    } catch (failure) {
      const refusal = saveRefusal(failure)
      if (refusal.field) setError(refusal.message)
      setFeedback({
        tone: 'error',
        text: refusal.field ? 'Rien n’a été enregistré : corrigez le champ signalé.' : refusal.message,
      })
    } finally {
      setStartedAt(null)
    }
  }

  return (
    <div className="settings-connections">
      <IntegrationCard
        id="settings-prompt-initial"
        icon={SparklesIcon}
        title="Tâche donnée à l’IA"
        subtitle="Donné à l’IA avant chaque rédaction d’un mail (Contact, R1, R2)"
      >
        <p className="settings-connection__sentence">
          Expliquez à l’IA sa tâche : qui elle est, à qui elle écrit et pourquoi. Elle le reçoit toujours en premier,
          suivi de règles non modifiables (n’utiliser que les faits connus, format du mail, lien de rendez-vous) et de la
          fiche du client.
        </p>
        <div className="settings-form">
          <TextAreaField
            label="Prompt initial"
            rows={12}
            maxLength={8000}
            value={draft}
            disabled={startedAt !== null}
            error={error ?? (blank ? 'Le prompt ne peut pas être vide : rétablissez le texte par défaut.' : undefined)}
            hint={
              <>
                {sourceText(setting)}
                {isDefault ? ' Texte par défaut de VIPER.' : ''}
              </>
            }
            onChange={(event) => {
              setEdit(event.target.value)
              setError(undefined)
            }}
          />
        </div>
        <FeedbackBanner feedback={feedback} />
        <div className="settings-connection__actions">
          <Button
            icon={UndoIcon}
            disabled={startedAt !== null || isDefault}
            onClick={() => {
              setEdit(data.initial_prompt_default)
              setFeedback(null)
            }}
          >
            Rétablir le texte par défaut
          </Button>
          <Button
            variant="primary"
            icon={SaveIcon}
            loading={startedAt !== null}
            disabled={!dirty || blank}
            onClick={() => void submit()}
          >
            {startedAt !== null ? `Enregistrement… ${String(elapsed)} s` : 'Enregistrer'}
          </Button>
        </div>
      </IntegrationCard>
    </div>
  )
}
