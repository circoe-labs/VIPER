import { EmptyState } from '../ui/EmptyState'
import { CheckCircleIcon } from '../ui/icons'

interface TabProps {
  missionId: string
}

// Placeholder until Slice 08 (result cards + review). Stable contract: `missionId` only. Until then the reviews
// are still opened from « Relire » in the Overview task list.
export function ResultsTab({ missionId }: TabProps) {
  return (
    <div data-mission-id={missionId}>
      <EmptyState
        icon={CheckCircleIcon}
        title="Résultats des agents"
        description="Les propositions à relire et déjà tranchées apparaîtront ici. En attendant, ouvrez « Relire » depuis les tâches de la vue d’ensemble."
      />
    </div>
  )
}
