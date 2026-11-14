import { useState } from 'react'

import { useAssistantCapabilities } from '../../api/missionAssistant'
import { IconButton } from '../../ui/Button'
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

// The dictation entry point of « Créer mission »: a round icon-only microphone in the dialog's footer (the dialog's
// `assistantSlot`). Optional by construction: when the AI is not configured the button is disabled and its tooltip says
// why; the form works exactly as before.
export function VoiceAssistantEntry({ form, submit }: VoiceAssistantEntryProps) {
  const capabilities = useAssistantCapabilities()
  const [open, setOpen] = useState(false)
  if (form.editing) return null

  const unavailable = capabilities.isSuccess && !capabilities.data.assistant
  const reason = unavailable
    ? 'La dictée demande la clé et le modèle IA du serveur (Administration › Config AI).'
    : capabilities.isError
      ? 'La dictée est momentanément indisponible.'
      : null

  return (
    <>
      <IconButton
        icon={MicIcon}
        label="Dicter la mission"
        variant="secondary"
        className="voice-entry__mic"
        disabled={!capabilities.isSuccess || unavailable}
        loading={capabilities.isPending}
        aria-describedby={reason ? 'voice-entry-reason' : undefined}
        title={reason ?? 'Dicter la mission'}
        onClick={() => {
          setOpen(true)
        }}
      />
      {reason && (
        <span id="voice-entry-reason" className="visually-hidden">
          {reason}
        </span>
      )}
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
    </>
  )
}
