import { useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'

import { ApiError } from '../api/client'
import { notesBatchKey, useNoteMutations, useProspectNotes } from '../api/prospectNotes'
import { refreshAfterWrite } from '../api/refresh'
import { DOES_NOT_KNOW_ROBIN, KNOWS_ROBIN, readNotes, type RobinState, todayIso } from '../prospection/robin'
import { Button } from '../ui/Button'
import { EditorSection } from './EditorSection'

interface ProspectRobinCardProps {
  prospectId: string
}

// « Robin » card (Profil tab, right column): does this person know Robin? Two buttons that write the same dated note as
// the « Qui connaît Robin ? » list (prospection/robin.ts), the latest one deciding; the list behind the fiche follows.
export function ProspectRobinCard({ prospectId }: ProspectRobinCardProps) {
  const queryClient = useQueryClient()
  const notes = useProspectNotes(prospectId)
  const { create } = useNoteMutations(prospectId)
  const [error, setError] = useState<string | null>(null)
  const { state } = readNotes(notes.data ?? [])

  function choose(next: RobinState) {
    if (state === next) return
    setError(null)
    create.mutate(
      { fact_text: next === 'knows' ? KNOWS_ROBIN : DOES_NOT_KNOW_ROBIN, noted_on: todayIso() },
      {
        onSuccess: () => {
          void refreshAfterWrite(queryClient, [notesBatchKey])
        },
        onError: (failure) => {
          setError(failure instanceof ApiError ? failure.message : 'L’enregistrement a échoué. Réessayez.')
        },
      },
    )
  }

  return (
    <EditorSection title="Robin">
      <div className="prospect-robin" role="group" aria-label="Ce prospect connaît-il Robin ?">
        <Button
          variant={state === 'knows' ? 'primary' : 'secondary'}
          aria-pressed={state === 'knows'}
          disabled={!notes.isSuccess || create.isPending}
          onClick={() => {
            choose('knows')
          }}
        >
          Connaît Robin
        </Button>
        <Button
          variant={state === 'unknown' ? 'primary' : 'secondary'}
          aria-pressed={state === 'unknown'}
          disabled={!notes.isSuccess || create.isPending}
          onClick={() => {
            choose('unknown')
          }}
        >
          Ne connaît pas Robin
        </Button>
      </div>
      {notes.isError && <p role="alert">Les notes n’ont pas pu être chargées.</p>}
      {error && <p role="alert">{error}</p>}
    </EditorSection>
  )
}
