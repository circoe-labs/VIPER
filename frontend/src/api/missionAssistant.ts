import { useQuery } from '@tanstack/react-query'

import { ApiError, apiGet, apiRequest } from './client'

// Mirrors backend/app/api/routes/mission_assistant.py; contract in doc/architecture/missions.md §7f.
// The assistant only proposes edits of the form's draft; the mission is created by the form's own save.

export interface AssistantCapabilities {
  // The OpenAI key + model are set (the conversation can run).
  assistant: boolean
  // A Whisper-compatible speech-to-text service is configured (else the browser's recognition, else typed text).
  speech: boolean
}

export interface DraftRecord {
  kind: 'company' | 'prospect' | 'warehouse'
  id: string
  label: string | null
  hint?: string | null
}

// The form's state as the server wants to read it (`null` = follows the category).
export interface DraftSnapshot {
  name: string
  category_id: string | null
  category_name: string | null
  result_kind: string | null
  prompt: string | null
  skill_ids: string[] | null
  source_ids: string[] | null
  targets: DraftRecord[]
  context_refs: DraftRecord[]
  recurring: boolean
  interval_count: number
  interval_unit: string
  starts_at: string
  end_kind: string
  ends_at: string
  max_runs: number | null
  task_count: number
  geography: string
  period_days: number | null
  exclude_known: boolean
  missing: string | null
}

export interface ChatMessage {
  role: 'user' | 'assistant'
  content: string
}

export interface DraftAction {
  tool: string
  args: Record<string, unknown>
  // The line shown on screen (« Catégorie : Prospection »).
  summary: string
}

export interface AssistantTurn {
  reply: string
  actions: DraftAction[]
  // The assistant asks to create: the form's validation and save decide.
  finalize: boolean
  model: string
}

export const assistantKeys = { capabilities: ['missions', 'assistant', 'capabilities'] as const }

export function useAssistantCapabilities() {
  return useQuery({
    queryKey: assistantKeys.capabilities,
    queryFn: ({ signal }) => apiGet<AssistantCapabilities>('/missions/assistant/capabilities', signal),
    staleTime: 60_000,
  })
}

export function assistantTurn(messages: ChatMessage[], draft: DraftSnapshot, signal?: AbortSignal): Promise<AssistantTurn> {
  return apiRequest<AssistantTurn>('POST', '/missions/assistant/turn', { body: { messages, draft }, signal })
}

export async function transcribeAudio(audio: Blob, signal?: AbortSignal): Promise<string> {
  const body = new FormData()
  body.append('audio', audio, 'speech.webm')
  const result = await apiRequest<{ text: string }>('POST', '/missions/assistant/transcribe', { body, signal })
  return result.text
}

const KNOWN: Record<string, string> = {
  ai_not_configured: 'L’assistant n’est pas configuré sur ce serveur (clé et modèle IA : Paramètres › Connexions).',
  ai_timeout: 'L’IA a mis trop de temps à répondre. Réessayez.',
  ai_rate_limited: 'L’IA est momentanément saturée. Réessayez dans un instant.',
  ai_auth_failed: 'La clé IA du serveur est refusée : prévenez un administrateur.',
  ai_upstream_error: 'Le service d’IA est injoignable. Réessayez.',
  ai_refused: 'L’IA a refusé de répondre à cette demande.',
  ai_invalid_output: 'La réponse de l’IA est inutilisable. Réessayez.',
  stt_not_configured: 'La transcription serveur n’est pas configurée.',
  stt_timeout: 'La transcription a pris trop de temps. Réessayez ou écrivez votre demande.',
  stt_upstream_error: 'Le service de transcription ne répond pas. Écrivez votre demande ou réessayez.',
  stt_invalid_audio: 'L’enregistrement n’a pas pu être lu. Réessayez.',
}

// A sentence for the person, from the server's typed refusal (never the raw HTTP failure).
export function assistantErrorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    const { detail } = error
    if (typeof detail === 'object' && detail !== null && 'code' in detail) {
      const code = String(detail.code)
      const known = KNOWN[code]
      if (known) return known
    }
    return 'Le service a répondu par une erreur. Réessayez.'
  }
  return 'Le serveur est injoignable. Vérifiez votre connexion.'
}
