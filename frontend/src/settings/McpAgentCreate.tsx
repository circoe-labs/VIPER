import { useState } from 'react'

import {
  type McpAgentCreated,
  type McpAgentMode,
  type McpAgentProvider,
  type McpSettings,
  useCreateMcpAgent,
} from '../api/mcpSettings'
import { settingsRefusal } from '../api/settings'
import { Button } from '../ui/Button'
import { Modal } from '../ui/Dialog'
import { Checkbox, SelectField, TextField } from '../ui/fields'

export const MODE_LABELS: Record<McpAgentMode, string> = {
  interactive: 'Assistant (agit pour vous)',
  worker: 'Worker (traite les tâches de mission)',
  scheduled: 'Assistant planifié',
}

export const PROVIDER_LABELS: Record<McpAgentProvider, string> = {
  chatgpt: 'ChatGPT',
  claude: 'Claude',
  chatx: 'ChatX',
  other: 'Autre',
}

// The backend's refusal in French: the role limit (403 `forbidden`), a field, or the generic failure.
function createErrorMessage(error: unknown): string {
  const refusal = settingsRefusal(error)
  if (refusal?.code === 'forbidden') {
    return 'Votre rôle ne permet pas d’accorder certaines de ces capacités : décochez-les.'
  }
  if (refusal?.code === 'invalid') {
    return refusal.field === 'label' ? 'Saisissez un nom (100 caractères au plus).' : 'Une capacité est inconnue.'
  }
  return 'Le jeton n’a pas pu être créé. Vérifiez la connexion puis réessayez.'
}

// « Créer un jeton »: a bearer token acting for the signed-in person, with its mode and capabilities. The token is
// shown once, in the same dialog, then never again.
export function CreateAgentDialog({ settings, onClose }: { settings: McpSettings; onClose: () => void }) {
  const create = useCreateMcpAgent()
  const grantable = new Set(settings.grantable)
  // A mode's defaults, without what the person's role does not allow (the backend would refuse them).
  const defaultsFor = (value: McpAgentMode) => settings.mode_defaults[value].filter((name) => grantable.has(name))
  const [label, setLabel] = useState('')
  const [provider, setProvider] = useState<McpAgentProvider>('other')
  const [mode, setMode] = useState<McpAgentMode>('worker')
  const [chosen, setChosen] = useState<string[]>(() => defaultsFor('worker'))
  const [created, setCreated] = useState<McpAgentCreated | null>(null)

  const toggle = (name: string, on: boolean) => {
    setChosen((current) => (on ? [...current, name] : current.filter((value) => value !== name)))
  }

  if (created) {
    return (
      <Modal open size="md" title="Jeton créé" onClose={onClose} footer={<Button onClick={onClose}>Fermer</Button>}>
        <div className="settings-dialog">
          <p>
            Copiez ce jeton maintenant : VIPER n’en garde que l’empreinte, il ne pourra plus être affiché. L’agent
            l’envoie en <code>Authorization: Bearer …</code>.
          </p>
          <code className="mcp-token" aria-label="Jeton">
            {created.token}
          </code>
        </div>
      </Modal>
    )
  }

  return (
    <Modal
      open
      size="md"
      title="Créer un jeton"
      onClose={onClose}
      footer={
        <>
          <Button disabled={create.isPending} onClick={onClose}>
            Annuler
          </Button>
          <Button
            variant="primary"
            loading={create.isPending}
            disabled={label.trim() === ''}
            onClick={() => {
              create.mutate(
                { label: label.trim(), provider, mode, capabilities: chosen },
                {
                  onSuccess: (answer) => {
                    setCreated(answer)
                  },
                },
              )
            }}
          >
            Créer le jeton
          </Button>
        </>
      }
    >
      <div className="settings-dialog">
        <TextField
          label="Nom"
          required
          maxLength={100}
          value={label}
          onChange={(event) => {
            setLabel(event.target.value)
          }}
        />
        <SelectField
          label="Plateforme"
          value={provider}
          onChange={(event) => {
            setProvider(event.target.value as McpAgentProvider)
          }}
        >
          {(Object.keys(PROVIDER_LABELS) as McpAgentProvider[]).map((value) => (
            <option key={value} value={value}>
              {PROVIDER_LABELS[value]}
            </option>
          ))}
        </SelectField>
        <SelectField
          label="Mode"
          hint="Changer de mode reprend ses capacités par défaut."
          value={mode}
          onChange={(event) => {
            const next = event.target.value as McpAgentMode
            setMode(next)
            setChosen(defaultsFor(next))
          }}
        >
          {(Object.keys(MODE_LABELS) as McpAgentMode[]).map((value) => (
            <option key={value} value={value}>
              {MODE_LABELS[value]}
            </option>
          ))}
        </SelectField>
        <fieldset className="mcp-capabilities">
          <legend className="field__label">Capacités</legend>
          <p className="field__hint">
            Vous ne pouvez accorder que ce que votre rôle permet. Un assistant reste en plus limité, à chaque appel, par
            le rôle de la personne pour qui il agit.
          </p>
          {settings.capabilities.map((capability) => (
            <Checkbox
              key={capability.name}
              label={capability.label}
              checked={chosen.includes(capability.name)}
              disabled={!grantable.has(capability.name)}
              hint={grantable.has(capability.name) ? undefined : 'Votre rôle ne permet pas de l’accorder.'}
              onChange={(event) => {
                toggle(capability.name, event.target.checked)
              }}
            />
          ))}
        </fieldset>
        {create.isError && (
          <p className="settings-error" role="alert">
            {createErrorMessage(create.error)}
          </p>
        )}
      </div>
    </Modal>
  )
}
