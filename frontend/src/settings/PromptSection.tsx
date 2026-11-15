import { type ComponentType, useState } from 'react'

import { type Integrations, type IntegrationField, useIntegrations, useIntegrationsMutations } from '../api/integrations'
import { useElapsed } from '../lib/useElapsed'
import { Badge } from '../ui/Badge'
import { Button } from '../ui/Button'
import { Modal } from '../ui/Dialog'
import { TextAreaField } from '../ui/fields'
import { AlertIcon, MailIcon, SaveIcon, SparklesIcon, UndoIcon } from '../ui/icons'
import { InfoTip } from '../ui/InfoTip'
import { saveRefusal, sourceText } from './integrationsModel'
import { type Feedback, FeedbackBanner } from './shared'
import './settings.css'

// Config AI › Prompt: two cards, the mail brief and the mission assistant's behaviour (same editor, same
// reset-to-default rule; the assistant's prompt is distinct from a category's general prompt, which instructs the
// worker agent, and from skills). The mail brief: the brief the AI always receives before it drafts a Contact / R1 / R2 e-mail (what it is,
// who it writes to, why). The mandatory rules (facts only, format, booking link) and the client card follow it and are
// not editable. The text saved here replaces the built-in one; saving the built-in text unchanged (or « Rétablir »)
// goes back to it. Each prompt is one card of a grid; a click opens its editor in a dialog.
export function PromptSection() {
  return <PromptGrid prompts={[CONTACT_PROMPT, MISSION_CREATOR_PROMPT]} />
}

// What differs between the prompts that share this editor. `field` is the integrations setting that stores the text
// (`null` = back to the built-in one, `defaultOf` reads that built-in text from the integrations answer).
interface PromptCopy {
  field: IntegrationField
  defaultOf: (data: Integrations) => string
  id: string
  // Name of the card (what the AI does with this prompt).
  card: string
  icon: ComponentType<{ size?: number }>
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
  card: 'Écrire un mail',
  icon: MailIcon,
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
  card: 'Lancer l’assistant de création de mission',
  icon: SparklesIcon,
  title: 'Assistant de création de mission',
  subtitle: 'Donné à l’assistant qui aide à rédiger une mission (saisie ou voix)',
  sentence:
    'Décrivez le comportement de l’assistant : comment il pose ses questions, ce qu’il propose et quand il demande une validation. Ce texte ne concerne que l’assistant de création ; la consigne des agents qui exécutent une mission se règle dans la catégorie (Administration › Catégories).',
  label: 'Comportement de l’assistant',
  saved: 'Comportement enregistré : il s’applique aux prochaines créations de mission.',
}

function PromptGrid({ prompts }: { prompts: PromptCopy[] }) {
  const integrations = useIntegrations()
  const [openId, setOpenId] = useState<string | null>(null)
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
  const data = integrations.data
  const opened = prompts.find((copy) => copy.id === openId)
  return (
    <>
      <ul className="prompt-grid" aria-label="Prompts">
        {prompts.map((copy) => {
          const setting = data.fields[copy.field]
          const text = typeof setting.value === 'string' ? setting.value : copy.defaultOf(data)
          const custom = text.trim() !== copy.defaultOf(data).trim()
          return (
            <li key={copy.id} className="prompt-grid__item">
              <button
                type="button"
                className="prompt-card"
                aria-label={`Configurer : ${copy.card}`}
                onClick={() => {
                  setOpenId(copy.id)
                }}
              >
                <span className="prompt-card__head">
                  <span className="prompt-card__icon">
                    <copy.icon size={20} />
                  </span>
                  <span className="prompt-card__title">{copy.card}</span>
                  <Badge tone={custom ? 'accent' : 'neutral'}>{custom ? 'Personnalisé' : 'Par défaut'}</Badge>
                </span>
                <span className="prompt-card__preview">{text}</span>
                <span className="prompt-card__cta">Configurer</span>
              </button>
            </li>
          )
        })}
      </ul>
      {opened && (
        <PromptDialog
          data={data}
          copy={opened}
          onClose={() => {
            setOpenId(null)
          }}
        />
      )}
    </>
  )
}

function PromptDialog({ data, copy, onClose }: { data: Integrations; copy: PromptCopy; onClose: () => void }) {
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
    <Modal
      open
      size="lg"
      title={copy.title}
      titleIcon={
        <span className="prompt-dialog__icon">
          <copy.icon size={20} />
        </span>
      }
      className="prompt-dialog"
      onClose={onClose}
      footer={
        <>
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
        </>
      }
    >
      <div className="prompt-dialog__body">
        <p className="prompt-dialog__lead">
          {copy.subtitle}
          <InfoTip label={`Aide : ${copy.card}`}>{copy.sentence}</InfoTip>
        </p>
        <TextAreaField
          label={copy.label}
          rows={14}
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
        <FeedbackBanner feedback={feedback} />
      </div>
    </Modal>
  )
}
