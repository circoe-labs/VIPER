import type { MissionCard } from '../api/missions'
import { CheckCircleIcon, ClockIcon, PlayIcon, TableIcon } from '../ui/icons'
import { MissionKpiGrid, MissionKpiTile } from './MissionKpiTile'
import { missionCounters, reviewQueueTotal } from './missionsListModel'

interface MissionsKpiBarProps {
  // The UNFILTERED list (undefined while loading, null when it failed to load): the counters never follow the filters.
  items: MissionCard[] | null | undefined
  // Tool-mode proposals outside any mission: `useMissionProposals().data.length` (undefined loading, null failed). The
  // missions' own pending results are read from `items`.
  proposals: number | null | undefined
}

// Unavailable (null) when either source failed, loading (undefined) while either is still loading.
function reviewQueue(items: MissionCard[] | null | undefined, proposals: number | null | undefined) {
  if (items === null || proposals === null) return null
  if (items === undefined || proposals === undefined) return undefined
  return reviewQueueTotal(items, proposals)
}

// The four counters above the list. Loading shows « – », a failed query « — » (indisponible), a real zero shows 0.
export function MissionsKpiBar({ items, proposals }: MissionsKpiBarProps) {
  const counters = items ? missionCounters(items) : undefined
  const missing = items === null ? null : undefined
  const toReview = reviewQueue(items, proposals)
  return (
    <MissionKpiGrid label="Indicateurs des missions">
      <MissionKpiTile label="Toutes les missions" value={counters ? counters.total : missing} icon={TableIcon} hue="green" />
      <MissionKpiTile label="Actives" value={counters ? counters.active : missing} icon={PlayIcon} hue="blue" />
      <MissionKpiTile label="En attente de relecture" value={toReview} icon={ClockIcon} hue="amber" />
      <MissionKpiTile label="Terminées" value={counters ? counters.done : missing} icon={CheckCircleIcon} hue="purple" />
    </MissionKpiGrid>
  )
}
