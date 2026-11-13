import { type KeyboardEvent, type SyntheticEvent, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

import { AlertIcon, CheckIcon, CloseIcon, MicIcon, SpinnerIcon, VolumeIcon } from '../../ui/icons'
import type { MissionFormApi } from '../useMissionForm'
import type { SpeechMode } from './useSpeechInput'
import { useVoiceConversation, type VoicePhase } from './useVoiceConversation'
import './voice.css'

interface VoiceOverlayProps {
  form: MissionFormApi
  mode: SpeechMode
  submit: () => void
  onClose: () => void
}

const STATUS: Record<VoicePhase, string> = {
  idle: 'En pause',
  listening: 'Je vous écoute',
  transcribing: 'Transcription…',
  thinking: 'Je réfléchis…',
  speaking: 'Je réponds',
}

const FOCUSABLE = 'button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])'

// The immersive voice surface over « Créer mission »: close top-left, the assistant's short answer in large white type
// in the upper third, what the person says in blue lower down, the live orb bottom-right. Typed input is always there
// (no microphone, no recognition, noisy room). Closing never creates a mission: the draft just stays in the form.
export function VoiceOverlay({ form, mode, submit, onClose }: VoiceOverlayProps) {
  const orbRef = useRef<HTMLButtonElement>(null)
  const rootRef = useRef<HTMLDivElement>(null)
  const [typed, setTyped] = useState('')
  const conversation = useVoiceConversation({
    form,
    mode,
    submit,
    close: onClose,
    onLevel: (level) => {
      orbRef.current?.style.setProperty('--level', level.toFixed(3))
    },
  })
  const { phase } = conversation

  useEffect(() => {
    const previous = document.activeElement
    rootRef.current?.focus()
    return () => {
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus()
    }
  }, [])

  // The dialog underneath also listens to the React tree: keys stop here so Esc closes only the overlay and Tab cannot
  // reach the form behind it.
  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    event.stopPropagation()
    if (event.key === 'Escape') {
      onClose()
      return
    }
    if (event.key !== 'Tab' || !rootRef.current) return
    const focusables = [...rootRef.current.querySelectorAll<HTMLElement>(FOCUSABLE)]
    const first = focusables[0]
    const last = focusables.at(-1)
    if (!first || !last) return
    const active = document.activeElement
    if (event.shiftKey && (active === first || active === rootRef.current)) {
      event.preventDefault()
      last.focus()
    } else if (!event.shiftKey && active === last) {
      event.preventDefault()
      first.focus()
    }
  }

  function submitTyped(event: SyntheticEvent) {
    event.preventDefault()
    conversation.sendText(typed)
    setTyped('')
  }

  const orbLabel =
    mode === 'none'
      ? 'Micro indisponible : écrivez votre demande'
      : phase === 'listening'
        ? 'J’ai fini de parler'
        : 'Parler'

  return createPortal(
    <div
      ref={rootRef}
      className="voice"
      role="dialog"
      aria-modal="true"
      aria-label="Assistant vocal de création de mission"
      tabIndex={-1}
      data-phase={phase}
      onKeyDown={handleKeyDown}
      onClick={(event) => {
        event.stopPropagation()
      }}
    >
      <button type="button" className="voice__close" onClick={onClose} aria-label="Fermer l’assistant vocal">
        <CloseIcon size={22} />
        <span className="voice__close-text">Fermer</span>
      </button>

      <div className="voice__tools">
        <span className="voice__status" role="status">
          {phase === 'thinking' || phase === 'transcribing' ? <SpinnerIcon size={16} /> : <span className="voice__dot" aria-hidden="true" />}
          {STATUS[phase]}
        </span>
        {conversation.canSpeak && (
          <button
            type="button"
            className="voice__icon-button"
            aria-pressed={conversation.voiceOut}
            aria-label={conversation.voiceOut ? 'Couper la voix de l’assistant' : 'Activer la voix de l’assistant'}
            onClick={conversation.toggleVoiceOut}
          >
            <VolumeIcon size={20} muted={!conversation.voiceOut} />
          </button>
        )}
      </div>

      <main className="voice__stage">
        <p className="voice__assistant" aria-live="polite">
          {conversation.assistantText}
        </p>
        {conversation.applied.length > 0 && (
          <ul className="voice__applied" aria-label="Modifications du brouillon">
            {conversation.applied.map((line) => (
              <li key={line}>
                <CheckIcon size={14} /> {line}
              </li>
            ))}
          </ul>
        )}
      </main>

      {conversation.error && (
        <div className="voice__error" role="alert">
          <AlertIcon size={20} />
          <span>{conversation.error}</span>
          <span className="voice__error-actions">
            {(conversation.canRetry || mode !== 'none') && (
              <button type="button" onClick={conversation.retry}>
                Réessayer
              </button>
            )}
            <button type="button" onClick={conversation.dismissError}>
              Écrire plutôt
            </button>
          </span>
        </div>
      )}

      <footer className="voice__foot">
        <div className="voice__speech">
          {mode === 'none' && !conversation.error && (
            <p className="voice__hint">La reconnaissance vocale n’est pas disponible ici : écrivez votre demande.</p>
          )}
          <p className={`voice__transcript${conversation.live ? ' is-live' : ''}`} aria-live="off">
            {conversation.transcript || (phase === 'listening' ? '…' : '')}
          </p>
          <form className="voice__typed" onSubmit={submitTyped}>
            <input
              type="text"
              value={typed}
              onChange={(event) => {
                setTyped(event.target.value)
              }}
              placeholder="Ou écrivez ici…"
              aria-label="Écrire votre demande"
              maxLength={1000}
              disabled={phase === 'thinking'}
            />
            <button type="submit" disabled={typed.trim() === '' || phase === 'thinking'}>
              Envoyer
            </button>
          </form>
        </div>

        <button
          ref={orbRef}
          type="button"
          className="voice__orb"
          onClick={conversation.toggleListening}
          disabled={mode === 'none' || phase === 'thinking' || phase === 'transcribing'}
          aria-label={orbLabel}
          aria-pressed={phase === 'listening'}
        >
          <span className="voice__orb-ring" aria-hidden="true" />
          <span className="voice__orb-core" aria-hidden="true">
            <MicIcon size={28} />
          </span>
        </button>
      </footer>
    </div>,
    document.body,
  )
}
