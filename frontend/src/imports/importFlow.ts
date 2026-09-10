import type { CommitResult, PreviewResult } from '../api/imports'
import { NO_DECISIONS, prunedDecisions, type ReviewDecisions } from './importPlan'

// The import page's state machine: file → analysis → sheet confirmation → review (à résoudre, rows) → commit →
// result. The file stays in memory (never uploaded for storage); every analysis sends it again (ADR-0012).
//
//   idle ──choose──► analyzing ──analyzed──► sheet ──confirmSheet──► review ──committed──► done
//     ▲                  │failed                ▲ reanalyze/analyzed ▲ reanalyze/analyzed      │
//     └──────────────────┴────── reset (from any step) ─────────────────────────────────────────┘

export type Step = 'idle' | 'analyzing' | 'sheet' | 'review' | 'done'

export interface FlowState {
  step: Step
  file: File | null
  preview: PreviewResult | null
  decisions: ReviewDecisions
  committed: CommitResult | null
  // A new analysis of the same file is running (corrections, other sheet, refreshed Settings).
  reanalyzing: boolean
  // French message of the last failure (file refused, analysis unavailable).
  error: string | null
}

export type FlowAction =
  | { type: 'choose'; file: File }
  | { type: 'reanalyze' }
  | { type: 'analyzed'; preview: PreviewResult }
  | { type: 'failed'; message: string }
  | { type: 'confirmSheet' }
  | { type: 'decide'; update: (decisions: ReviewDecisions) => ReviewDecisions }
  | { type: 'committed'; result: CommitResult }
  | { type: 'reset' }

export const INITIAL_FLOW: FlowState = {
  step: 'idle',
  file: null,
  preview: null,
  decisions: NO_DECISIONS,
  committed: null,
  reanalyzing: false,
  error: null,
}

export function flowReducer(state: FlowState, action: FlowAction): FlowState {
  switch (action.type) {
    case 'choose':
      return { ...INITIAL_FLOW, step: 'analyzing', file: action.file }
    case 'reanalyze':
      return state.file ? { ...state, reanalyzing: true, error: null } : state
    case 'analyzed':
      if (state.step === 'analyzing') {
        return { ...state, step: 'sheet', preview: action.preview, error: null }
      }
      return {
        ...state,
        preview: action.preview,
        decisions: prunedDecisions(state.decisions, action.preview.review),
        reanalyzing: false,
        error: null,
      }
    case 'failed':
      // A refused first analysis goes back to the file choice; a failed new analysis keeps the current review.
      return state.step === 'analyzing'
        ? { ...INITIAL_FLOW, error: action.message }
        : { ...state, reanalyzing: false, error: action.message }
    case 'confirmSheet':
      return state.step === 'sheet' ? { ...state, step: 'review' } : state
    case 'decide':
      return { ...state, decisions: action.update(state.decisions) }
    case 'committed':
      return { ...state, step: 'done', committed: action.result }
    case 'reset':
      return INITIAL_FLOW
  }
}
