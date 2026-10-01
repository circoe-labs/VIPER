import { useEffect, useRef, useState } from 'react'

import type { Message } from '../api/contact'
import { Button } from '../ui/Button'
import { TextAreaField } from '../ui/fields'
import { ChevronDownIcon, InfoIcon, SparklesIcon, SpinnerIcon } from '../ui/icons'
import { type AiAvailability, formatCount, generatedNote, INSTRUCTION_MAX_LENGTH } from './aiDraftModel'

// The AI drafting controls of the mail editor (Contact port S5): the button in the action bar's left slot (secondary —
// the primary action of a draft stays « Valider… »), the optional « consigne » behind a disclosure, the running state
// with its live counter, and the « Rédigé par l'IA » note of a generated text. Rules: aiDraftModel.ts.

interface AiButtonsProps {
  availability: AiAvailability
  running: boolean
  instructionOpen: boolean
  instructionId: string
  onToggleInstruction: () => void
  onGenerate: () => void
}

export function AiButtons({
  availability,
  running,
  instructionOpen,
  instructionId,
  onToggleInstruction,
  onGenerate,
}: AiButtonsProps) {
  if (!availability.show) return null
  return (
    <>
      <Button icon={SparklesIcon} loading={running} disabled={!availability.enabled} onClick={onGenerate}>
        {availability.label}
      </Button>
      {availability.enabled || instructionOpen ? (
        <Button
          variant="ghost"
          icon={ChevronDownIcon}
          className={instructionOpen ? 'contact-ai__toggle contact-ai__toggle--open' : 'contact-ai__toggle'}
          aria-expanded={instructionOpen}
          aria-controls={instructionId}
          disabled={running}
          onClick={onToggleInstruction}
        >
          Consigne
        </Button>
      ) : null}
    </>
  )
}

// Whole seconds since `startedAt` (epoch ms), ticking every second; 0 while idle.
function useElapsed(startedAt: number | null): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (startedAt === null) return
    const timer = window.setInterval(() => {
      setNow(Date.now())
    }, 1000)
    return () => {
      window.clearInterval(timer)
    }
  }, [startedAt])
  return startedAt === null ? 0 : Math.max(0, Math.floor((now - startedAt) / 1000))
}

interface AiPanelProps {
  stepLabel: string
  availability: AiAvailability
  // When the running request was sent (epoch ms); null while idle.
  startedAt: number | null
  instructionOpen: boolean
  instructionId: string
  instruction: string
  onInstruction: (value: string) => void
}

// Above the action bar: why the button is disabled, the running state, or the « consigne » field. Empty otherwise.
// Accessibility: one always-mounted live region says when the AI starts (the outcome is the editor's Notice); the
// clicked button turns disabled while it runs, so the focus moves to the running block instead of the page body.
export function AiPanel({
  stepLabel,
  availability,
  startedAt,
  instructionOpen,
  instructionId,
  instruction,
  onInstruction,
}: AiPanelProps) {
  const running = startedAt !== null
  const elapsed = useElapsed(startedAt)
  const progressRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!running) return
    // After the confirmation dialog has given the focus back to the (now disabled) button.
    const timer = window.setTimeout(() => {
      const active = document.activeElement
      const lost = !active || active === document.body || (active instanceof HTMLButtonElement && active.disabled)
      if (lost) progressRef.current?.focus()
    }, 0)
    return () => {
      window.clearTimeout(timer)
    }
  }, [running])
  const live = (
    <p className="visually-hidden" role="status">
      {running ? `L’IA rédige le message ${stepLabel}…` : ''}
    </p>
  )
  if (!availability.show) return live
  return (
    <>
      {live}
      {availability.note && (
        <p className="contact-ai__note">
          <InfoIcon size={16} />
          {availability.note}
        </p>
      )}
      {running && (
        <div ref={progressRef} tabIndex={-1} className="contact-ai__progress">
          <p>
            <SpinnerIcon size={16} className="btn__spinner" />
            <span>L’IA rédige le message {stepLabel}…</span>
            <span className="contact-ai__elapsed" aria-hidden="true">
              {String(elapsed)} s
            </span>
          </p>
          <p className="contact-mail__hint">
            Rien n’est modifié avant son arrivée (quelques minutes au plus). Vous pouvez changer d’onglet : la proposition
            sera enregistrée comme Brouillon.
          </p>
        </div>
      )}
      {instructionOpen && (
        <div id={instructionId}>
          <TextAreaField
            id={`${instructionId}-field`}
            label="Consigne pour l’IA (facultatif)"
            hint={`Ex. : plus court, insister sur la logistique. ${formatCount(INSTRUCTION_MAX_LENGTH)} caractères au plus ; l’IA n’invente aucun fait.`}
            value={instruction}
            maxLength={INSTRUCTION_MAX_LENGTH}
            rows={2}
            readOnly={running}
            onChange={(event) => {
              onInstruction(event.target.value)
            }}
          />
        </div>
      )}
    </>
  )
}

// « Rédigé par l'IA — à relire », with the model and prompt version as a subtle hint.
export function GeneratedNote({ message, textEdited }: { message: Message | null; textEdited: boolean }) {
  const note = generatedNote(message, textEdited)
  if (!note) return null
  return (
    <p className="contact-ai__generated">
      <SparklesIcon size={16} />
      <span>{note.text}</span>
      <span className="contact-ai__model">{note.hint}</span>
    </p>
  )
}
