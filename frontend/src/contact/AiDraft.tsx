import { useEffect, useRef } from 'react'

import type { Message } from '../api/contact'
import { useElapsed } from '../lib/useElapsed'
import { SparklesIcon, SpinnerIcon } from '../ui/icons'
import { generatedNote } from './aiDraftModel'
import type { Signal } from './MailSignals'

// The AI drafting's presence in the mail editor (Contact port S5): the running state with its live counter, and the
// « Rédigé par l'IA » signal of a generated text. The buttons live in the action bar (MailActionBar), the instruction,
// tone and sender in « Paramètres avancés » (AdvancedSettings). Rules: aiDraftModel.ts.

interface AiProgressProps {
  stepLabel: string
  // When the running request was sent (epoch ms); null while idle.
  startedAt: number | null
}

// Accessibility: one always-mounted live region says when the AI starts (the outcome is the editor's notice); the
// clicked button turns disabled while it runs, so the focus moves to the running badge instead of the page body.
export function AiProgress({ stepLabel, startedAt }: AiProgressProps) {
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
  return (
    <>
      <p className="visually-hidden" role="status">
        {running ? `L’IA rédige le message ${stepLabel}…` : ''}
      </p>
      {running && (
        <div
          ref={progressRef}
          tabIndex={-1}
          className="contact-ai__progress"
          title="Rien n’est modifié avant son arrivée (quelques minutes au plus). Vous pouvez changer d’onglet : la proposition sera enregistrée comme Brouillon."
        >
          <SpinnerIcon size={16} className="btn__spinner" />
          <span>L’IA rédige…</span>
          <span className="contact-ai__elapsed" aria-hidden="true">
            {String(elapsed)} s
          </span>
        </div>
      )}
    </>
  )
}

// « Rédigé par l'IA — à relire », with the model and prompt version in its detail.
export function generatedSignal(message: Message | null, textEdited: boolean): Signal | null {
  const note = generatedNote(message, textEdited)
  if (!note) return null
  return {
    id: 'generated',
    tone: 'info',
    icon: SparklesIcon,
    label: note.text,
    detail: (
      <>
        <p>{note.text}</p>
        <p className="mail-popover__meta">{note.hint}</p>
      </>
    ),
  }
}
