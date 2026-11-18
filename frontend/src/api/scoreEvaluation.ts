import { useMutation, useMutationState, useQueryClient } from '@tanstack/react-query'
import { useCallback } from 'react'

import { ApiError, apiRequest } from './client'
import { type Prospect, type ProspectScore, prospectKeys } from './prospects'

// Mirrors backend/app/api/routes/prospect_scoring.py: « Évaluer / Réévaluer le score » asks the LLM directly (no external
// agent, 2026-11-18) and answers the prospect's new displayed score, in seconds. Contract: backend/app/services/prospect_scoring.py.
//
// Several places start the same evaluation (the card, the Mission menu's « Réanalyse son score », the sheet's « … » and
// right-click menus). They share ONE mutation key per prospect, so the card shows the progress whoever started it.

// A request that never answers must not leave the card running for ever: past this the person is told how long it waited.
// The backend's own deadline (VIPER_OPENAI_TIMEOUT_MS, 60 s by default) normally answers first.
export const EVALUATION_DEADLINE_MS = 120_000

export function scoreEvaluationKey(prospectId: string) {
  return ['prospects', prospectId, 'score-evaluation'] as const
}

export interface EvaluationState {
  status: 'idle' | 'pending' | 'success' | 'error'
  // Epoch ms the latest request was sent; null while idle.
  startedAt: number | null
  error: unknown
  // The score before the request, for the ring to ease from it.
  previous: ProspectScore | null
}

const IDLE: EvaluationState = { status: 'idle', startedAt: null, error: null, previous: null }

// The latest evaluation of this prospect, whoever started it (React Query keeps the mutation state a few minutes).
export function useEvaluationState(prospectId: string | null): EvaluationState {
  const states = useMutationState({
    filters: { mutationKey: scoreEvaluationKey(prospectId ?? '') },
    select: (mutation): EvaluationState => ({
      status: mutation.state.status === 'idle' ? 'idle' : mutation.state.status,
      startedAt: mutation.state.submittedAt || null,
      error: mutation.state.error,
      previous: (mutation.state.variables as { previous: ProspectScore | null } | undefined)?.previous ?? null,
    }),
  })
  return states.at(-1) ?? IDLE
}

// `start()` asks for an evaluation; the score shown before it (for the ring to ease from) is read from the prospect's cache
// unless the caller gives it.
export function useEvaluateScore(prospectId: string) {
  const queryClient = useQueryClient()
  const mutation = useMutation({
    mutationKey: scoreEvaluationKey(prospectId),
    // The variables only carry the previous score, read back from the mutation state (`useEvaluationState`).
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    mutationFn: (_variables: { previous: ProspectScore | null }) =>
      apiRequest<ProspectScore>('POST', `/prospects/${encodeURIComponent(prospectId)}/score/evaluate`, {
        signal: AbortSignal.timeout(EVALUATION_DEADLINE_MS),
      }),
    onSuccess: (score) => {
      // The score card reads the prospect: the new displayed score replaces the old one in place.
      queryClient.setQueryData<Prospect>(prospectKeys.detail(prospectId), (current) => (current ? { ...current, score } : current))
    },
  })
  const { mutate } = mutation
  const start = useCallback(
    (previous?: ProspectScore | null, callbacks?: { onSuccess?: (score: ProspectScore) => void; onError?: (error: unknown) => void }) => {
      mutate({ previous: previous ?? queryClient.getQueryData<Prospect>(prospectKeys.detail(prospectId))?.score ?? null }, callbacks)
    },
    [mutate, queryClient, prospectId],
  )
  return { start, isPending: mutation.isPending }
}

const KNOWN: Record<string, string> = {
  ai_not_configured: 'L’IA n’est pas configurée : renseignez la clé et le modèle dans Config AI › Connexions.',
  ai_timeout: 'L’IA n’a pas répondu à temps.',
  ai_rate_limited: 'Trop de demandes à l’IA, ou quota OpenAI épuisé.',
  ai_auth_failed: 'La clé OpenAI a été refusée : vérifiez-la dans Config AI › Connexions.',
  ai_model_not_found: 'Le modèle IA configuré est introuvable : vérifiez-le dans Config AI › Connexions.',
  ai_upstream_error: 'Le service d’IA a échoué ou est injoignable.',
  ai_refused: 'L’IA a refusé d’évaluer ce prospect.',
  ai_invalid_output: 'La réponse de l’IA était inutilisable.',
  not_found: 'Ce prospect n’existe plus.',
}

// One sentence, in French, saying what actually happened (the server's typed code, never the raw HTTP failure).
export function evaluationFailure(error: unknown): string {
  if (error instanceof DOMException && (error.name === 'TimeoutError' || error.name === 'AbortError')) {
    return `Pas de réponse après ${String(EVALUATION_DEADLINE_MS / 1000)} s.`
  }
  if (error instanceof ApiError) {
    const { detail } = error
    if (typeof detail === 'object' && detail !== null && 'code' in detail) {
      const known = KNOWN[String(detail.code)]
      if (known) return known
      if ('message' in detail && typeof detail.message === 'string') return detail.message
    }
    return `Le serveur a refusé l’évaluation (HTTP ${String(error.status)}).`
  }
  return 'Le serveur VIPER est injoignable.'
}

export interface ScoringTest {
  prospect_id: string
  prospect_name: string
  score: number
  rationale: string
  criteria: { label: string; delta: number; evidence: string }[]
  model: string
  prompt_version: string
  duration_ms: number
}

// Config AI › Scoring prospect, « Tester sur un prospect »: the saved prompt and target on the latest prospect, nothing stored.
export function useScoringTest() {
  return useMutation({
    mutationFn: () => apiRequest<ScoringTest>('POST', '/settings/integrations/scoring/test', { signal: AbortSignal.timeout(EVALUATION_DEADLINE_MS) }),
  })
}
