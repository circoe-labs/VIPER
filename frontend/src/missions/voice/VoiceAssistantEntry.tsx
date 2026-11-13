import { useState } from 'react'

import { useAssistantCapabilities } from '../../api/missionAssistant'
import { Button } from '../../ui/Button'
import { MicIcon } from '../../ui/icons'
import type { MissionFormApi } from '../useMissionForm'
import { chooseSpeechMode } from './useSpeechInput'
import { VoiceOverlay } from './VoiceOverlay'
import './voice.css'

interface VoiceAssistantEntryProps {
  form: MissionFormApi
  // The form's own save: the assistant never creates a mission any other way.
  submit: () => void
}

// The microphone entry point of « Créer mission » (the dialog's `assistantSlot`). Optional by construction: when the AI
// is not configured the button says why and the form works exactly as before.
export function VoiceAssistantEntry({ form, submit }: VoiceAssistantEntryProps) {
  const capabilities = useAssistantCapabilities()
  const [open, setOpen] = useState(false)
  if (form.editing) return null

  const unavailable = capabilities.isSuccess && !capabilities.data.assistant
  const reason = unavailable
    ? 'L’assistant vocal demande la clé et le modèle IA du serveur (Paramètres › Connexions).'
    : capabilities.isError
      ? 'L’assistant vocal est momentanément indisponible.'
      : null

  return (
    <div className="voice-entry">
      <Button
        icon={MicIcon}
        variant="secondary"
        disabled={!capabilities.isSuccess || unavailable}
        loading={capabilities.isPending}
        onClick={() => {
          setOpen(true)
        }}
      >
        Créer à la voix
      </Button>
      <p className="voice-entry__hint">
        {reason ?? 'Décrivez la mission à l’oral : l’assistant remplit ce formulaire, vous validez.'}
      </p>
      {open && capabilities.data && (
        <VoiceOverlay
          form={form}
          mode={chooseSpeechMode(capabilities.data.speech)}
          submit={submit}
          onClose={() => {
            setOpen(false)
          }}
        />
      )}
    </div>
  )
}
