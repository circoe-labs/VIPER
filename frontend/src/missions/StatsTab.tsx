import { EmptyState } from '../ui/EmptyState'
import { InfoIcon } from '../ui/icons'

interface TabProps {
  missionId: string
}

// Placeholder until Slice 09 (activity/result metrics and charts). Stable contract: `missionId` only.
export function StatsTab({ missionId }: TabProps) {
  return (
    <div data-mission-id={missionId}>
      <EmptyState
        icon={InfoIcon}
        title="Statistiques de la mission"
        description="Les courbes d’activité et les taux d’acceptation des résultats apparaîtront ici."
      />
    </div>
  )
}
