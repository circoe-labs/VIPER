// The AI drafting of a step's mail (Contact port S5; decisions 22 and 26), pure rules. The AI only writes the subject
// and the body; the result is always a Brouillon to review, edit and validate by hand. The server holds the key and the
// model (`VIPER_OPENAI_*`) and says whether the drafting is configured (`defaults.generation_available`).
import type { GenerateRequest, GenerationResult, Message, MessageStep } from '../api/contact'
import { STEP_LABELS } from './labels'
import { messageRefusal, type MessageRefusal, refusalOf } from './messages'

// Must match backend MAX_INSTRUCTION_LENGTH (app/services/mail_generation/prompt.py).
export const INSTRUCTION_MAX_LENGTH = 1000
// The browser stops waiting after this long (the server bounds its own wait: timeout × attempts, about 3 min by
// default); a proposal that still arrives later is saved as a Brouillon and shows on reload.
export const GENERATION_DEADLINE_MS = 5 * 60 * 1000

// « 1 000 » (French grouping with a narrow no-break space, also below 10 000).
export function formatCount(value: number): string {
  return new Intl.NumberFormat('fr-FR', { useGrouping: 'always' }).format(value)
}

// The « consigne » of one step, kept by the sequence across tab switches (like the unsaved text).
export interface AiInstruction {
  text: string
  open: boolean
}

export const NO_INSTRUCTION: AiInstruction = { text: '', open: false }

export interface AiAvailability {
  // Shown at all (the step can be edited).
  show: boolean
  enabled: boolean
  label: string
  // Why the button is disabled, said next to it; null when enabled.
  note: string | null
}

export function hasText(message: Message | null): boolean {
  return message !== null && (message.subject.trim() !== '' || message.body_text.trim() !== '')
}

export function aiAvailability(input: {
  message: Message | null
  editable: boolean
  available: boolean
  busy: boolean
  // The step the AI is writing now (the request is shared by the sequence's tabs), null while idle.
  generatingStep?: MessageStep | null
  step?: MessageStep
}): AiAvailability {
  const label = hasText(input.message) ? 'Régénérer avec l’IA' : 'Générer avec l’IA'
  if (!input.editable) return { show: false, enabled: false, label, note: null }
  if (!input.available) {
    return {
      show: true,
      enabled: false,
      label,
      note: 'La rédaction par l’IA n’est pas configurée sur ce serveur (clé et modèle OpenAI) : rédigez le message vous-même.',
    }
  }
  if (input.generatingStep && input.step && input.generatingStep !== input.step) {
    return {
      show: true,
      enabled: false,
      label,
      note: `L’IA rédige déjà le message ${STEP_LABELS[input.generatingStep]} : attendez qu’elle ait fini pour générer celui-ci.`,
    }
  }
  if (input.message?.status === 'scheduled') {
    return { show: true, enabled: false, label, note: 'Message programmé : déprogrammez-le avant de le régénérer.' }
  }
  return { show: true, enabled: !input.busy, label, note: null }
}

// `POST …/generate` body: the revision once the step exists, the instruction when typed, `replace` when a saved text is
// replaced (the person confirmed it).
export function generationPayload(message: Message | null, instruction: string): GenerateRequest {
  const text = instruction.trim().slice(0, INSTRUCTION_MAX_LENGTH)
  return {
    ...(message ? { expected_revision: message.revision } : {}),
    ...(text ? { instruction: text } : {}),
    ...(hasText(message) ? { replace: true } : {}),
  }
}

export interface AiConfirmation {
  title: string
  lines: string[]
}

// Asked before anything would be lost: a saved text, unsaved edits, a validation. Null: generate at once.
export function generationConfirmation(step: MessageStep, message: Message | null, dirty: boolean): AiConfirmation | null {
  const saved = hasText(message)
  const validated = message?.status === 'validated'
  if (!saved && !dirty && !validated) return null
  const label = STEP_LABELS[step]
  return {
    title: `${saved ? 'Régénérer' : 'Générer'} le message ${label} ?`,
    lines: [
      ...(saved ? ['L’objet et le corps enregistrés seront remplacés par la proposition de l’IA.'] : []),
      ...(dirty ? ['Vos modifications non enregistrées seront perdues.'] : []),
      ...(validated ? ['Le message repassera en Brouillon : il faudra le relire puis le revalider.'] : []),
      'La proposition reste un Brouillon à relire : rien n’est validé ni envoyé.',
    ],
  }
}

// The outcome said under the editor.
export function generationNotice(step: MessageStep, result: GenerationResult): string {
  const label = STEP_LABELS[step]
  const back = result.unvalidated ? ' Il est repassé en Brouillon : à revalider.' : ''
  return `Brouillon ${label} rédigé par l’IA : relisez-le, corrigez-le si besoin, puis validez-le.${back}`
}

const AI_ERRORS: Record<string, string> = {
  ai_not_configured:
    'La rédaction par l’IA n’est pas configurée sur le serveur (clé ou modèle OpenAI manquant). Rien n’a été modifié.',
  ai_timeout: 'L’IA n’a pas répondu à temps. Rien n’a été modifié : réessayez.',
  ai_rate_limited:
    'Trop de demandes à l’IA pour le moment, ou quota OpenAI épuisé. Rien n’a été modifié : réessayez dans quelques minutes.',
  ai_auth_failed: 'La clé OpenAI du serveur a été refusée. Rien n’a été modifié : prévenez la personne qui administre VIPER.',
  ai_upstream_error: 'Le service d’IA a échoué ou est injoignable. Rien n’a été modifié : réessayez.',
  ai_refused: 'L’IA a refusé de rédiger ce message. Rien n’a été modifié : reformulez la consigne ou rédigez-le vous-même.',
  ai_invalid_output:
    'La proposition de l’IA était inutilisable (incomplète, champ à compléter ou lien non fourni). Rien n’a été modifié : réessayez.',
}

// A failed generation, in French: the AI's own codes, else the message refusals (closed sequence, conflict…).
export function generationRefusal(error: unknown): MessageRefusal {
  if (error instanceof DOMException && (error.name === 'TimeoutError' || error.name === 'AbortError')) {
    return {
      message: `Pas de réponse du serveur après ${String(GENERATION_DEADLINE_MS / 60_000)} min. Si la proposition arrive plus tard, elle sera enregistrée comme Brouillon : l’affichage est actualisé.`,
      fields: {},
      reload: true,
    }
  }
  const code = refusalOf(error)?.code
  if (code && code in AI_ERRORS) return { message: AI_ERRORS[code] ?? '', fields: {}, reload: false }
  if (code === 'replace_confirmation_required') {
    return { message: 'Ce message a déjà un texte : l’affichage est actualisé, relancez la génération pour le remplacer.', fields: {}, reload: true }
  }
  return messageRefusal(error)
}

// « Rédigé par l’IA — à relire » while the AI's text awaits its review; the model and prompt version as a subtle hint.
// A person's rewrite of the subject or body ends the mention once saved (the server clears the provenance; recipients-only
// edits keep it); `textEdited` says so beforehand.
export function generatedNote(message: Message | null, textEdited = false): { text: string; hint: string } | null {
  if (!message?.generation_model) return null
  const hint = `Modèle ${message.generation_model} · prompt ${message.generation_prompt_version ?? 'inconnu'}`
  if (textEdited) return { text: 'Rédigé par l’IA, modifié par vous : la mention disparaîtra à l’enregistrement.', hint }
  return {
    text: message.status === 'draft' ? 'Rédigé par l’IA — à relire avant de valider.' : 'Rédigé par l’IA.',
    hint,
  }
}
