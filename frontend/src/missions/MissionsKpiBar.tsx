import type { MissionCard } from '../api/missions'
import { CheckCircleIcon, ClockIcon, PlayIcon, TableIcon } from '../ui/icons'
import { MissionKpiGrid, MissionKpiTile } from './MissionKpiTile'
import { missionCounters } from './missionsListModel'

interface MissionsKpiBarProps {
  // The UNFILTERED list (undefined while loading, null when it failed to load): the counters never follow the filters.
  items: MissionCard[] | null | undefined
  // Results waiting for a human decision: `useMissionProposals().data.length` (undefined loading, null failed).
  toReview: number | null | undefined
}

// The four counters above the list. Loading shows « – », a failed query « — » (indisponible), a real zero shows 0.
export function MissionsKpiBar({ items, toReview }: MissionsKpiBarProps) {
  const counters = items ? missionCounters(items) : undefined
  const missing = items === null ? null : undefined
  return (
    <MissionKpiGrid label="Indicateurs des missions">
      <MissionKpiTile label="Toutes les missions" value={counters ? counters.total : missing} icon={TableIcon} hue="green" />
      <MissionKpiTile label="Actives" value={counters ? counters.active : missing} icon={PlayIcon} hue="blue" />
      <MissionKpiTile label="En attente de relecture" value={toReview} icon={ClockIcon} hue="amber" />
      <MissionKpiTile label="Terminées" value={counters ? counters.done : missing} icon={CheckCircleIcon} hue="purple" />
    </MissionKpiGrid>
  )
}
