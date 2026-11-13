import { useState } from 'react'

import { type Integrations, type IntegrationField, useIntegrations, useIntegrationsMutations } from '../api/integrations'
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
  return <PromptEditorSection copy={CONTACT_PROMPT} />
}

// Paramètres › Assistant de mission: the behaviour prompt of the assistant that helps write a mission draft (voice or
// text). Same editor, same reset-to-default rule; distinct from a category's general prompt, which instructs the worker
// agent, and from skills.
export function MissionCreatorPromptSection() {
  return <PromptEditorSection copy={MISSION_CREATOR_PROMPT} />
}

// What differs between the prompts that share this editor. `field` is the integrations setting that stores the text
// (`null` = back to the built-in one, `defaultOf` reads that built-in text from the integrations answer).
interface PromptCopy {
  field: IntegrationField
  defaultOf: (data: Integrations) => string
  id: string
  title: string
  subtitle: string
  sentence: string
  label: string
  saved: string
}

const CONTACT_PROMPT: PromptCopy = {
  field: 'contact_initial_prompt',
  defaultOf: (data) => data.initial_prompt_default,
  id: 'settings-prompt-initial',
  title: 'Tâche donnée à l’IA',
  subtitle: 'Donné à l’IA avant chaque rédaction d’un mail (Contact, R1, R2)',
  sentence:
    'Expliquez à l’IA sa tâche : qui elle est, à qui elle écrit et pourquoi. Elle le reçoit toujours en premier, suivi de règles non modifiables (n’utiliser que les faits connus, format du mail, lien de rendez-vous) et de la fiche du client.',
  label: 'Prompt initial',
  saved: 'Prompt initial enregistré : il s’applique aux prochains mails générés.',
}

const MISSION_CREATOR_PROMPT: PromptCopy = {
  field: 'mission_creator_prompt',
  defaultOf: (data) => data.mission_creator_prompt_default,
  id: 'settings-prompt-mission-creator',
  title: 'Assistant de création de mission',
  subtitle: 'Donné à l’assistant qui aide à rédiger une mission (saisie ou voix)',
  sentence:
    'Décrivez le comportement de l’assistant : comment il pose ses questions, ce qu’il propose et quand il demande une validation. Ce texte ne concerne que l’assistant de création ; la consigne des agents qui exécutent une mission se règle dans la catégorie (Administration › Catégories).',
  label: 'Comportement de l’assistant',
  saved: 'Comportement enregistré : il s’applique aux prochaines créations de mission.',
}

function PromptEditorSection({ copy }: { copy: PromptCopy }) {
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
  return <PromptCard data={integrations.data} copy={copy} />
}

function PromptCard({ data, copy }: { data: Integrations; copy: PromptCopy }) {
  const { save } = useIntegrationsMutations()
  const setting = data.fields[copy.field]
  const defaultText = copy.defaultOf(data)
  const saved = typeof setting.value === 'string' ? setting.value : defaultText
  const [edit, setEdit] = useState<string | null>(null)
  const [feedback, setFeedback] = useState<Feedback | null>(null)
  const [error, setError] = useState<string>()
  const [startedAt, setStartedAt] = useState<number | null>(null)
  const elapsed = useElapsed(startedAt)

  const draft = edit ?? saved
  const blank = draft.trim() === ''
  const dirty = draft.trim() !== saved.trim()
  const isDefault = draft.trim() === defaultText.trim()

  async function submit() {
    setFeedback(null)
    setError(undefined)
    setStartedAt(Date.now())
    try {
      // The built-in text is not stored: the setting goes back to following it.
      await save.mutateAsync({
        version: data.version,
        changes: { [copy.field]: isDefault ? null : draft.trim() },
      })
      setEdit(null)
      setFeedback({ tone: 'success', text: copy.saved })
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
        id={copy.id}
        icon={SparklesIcon}
        title={copy.title}
        subtitle={copy.subtitle}
      >
        <p className="settings-connection__sentence">{copy.sentence}</p>
        <div className="settings-form">
          <TextAreaField
            label={copy.label}
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
              setEdit(defaultText)
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
