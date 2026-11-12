import { EmptyState } from '../ui/EmptyState'
import { ClockIcon } from '../ui/icons'

interface TabProps {
  missionId: string
}

// Placeholder until Slice 07 (live/recent agent activity). Stable contract: `missionId` only; the shell never
// passes anything else, so Slice 07 replaces this body without touching MissionDetailPage.
export function ActivityTab({ missionId }: TabProps) {
  return (
    <div data-mission-id={missionId}>
      <EmptyState
        icon={ClockIcon}
        title="Activité des agents"
        description="Le journal des recherches et des sources consultées par les agents apparaîtra ici."
      />
    </div>
  )
}
