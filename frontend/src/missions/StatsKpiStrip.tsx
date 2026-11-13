import type { UseQueryResult } from '@tanstack/react-query'

import type { MissionOverview } from '../api/missions'
import { CheckCircleIcon, ClockIcon, ColumnsIcon, UsersIcon } from '../ui/icons'
import { MissionKpiGrid, MissionKpiTile } from './MissionKpiTile'
import { progressOf } from './statsSelectors'

interface StatsKpiStripProps {
  overview: UseQueryResult<MissionOverview>
}

// Four tiles of the reference screen, all from `GET /missions/{id}/overview`: agents with an active session now, and
// task counters (traitées = accepted + failed + cancelled, restantes = total - traitées, totales).
// Loading -> « – »; failed without data -> « — » + reason; never a placeholder zero.
export function StatsKpiStrip({ overview }: StatsKpiStripProps) {
  const data = overview.data
  const unavailable = !data && overview.isError
  const progress = data ? progressOf(data) : null
  const pick = (value: number | undefined): number | null | undefined => {
    if (data) return value
    return unavailable ? null : undefined
  }
  const why = unavailable ? 'Indisponible : tâches non chargées.' : undefined
  return (
    <MissionKpiGrid label="Indicateurs d’exécution de la mission">
      <MissionKpiTile
        label="Agents actifs"
        icon={UsersIcon}
        hue="blue"
        value={pick(data?.active_agents)}
        hint={data ? 'Avec une session active maintenant.' : why}
      />
      <MissionKpiTile
        label="Tâches traitées"
        icon={CheckCircleIcon}
        hue="green"
        value={pick(progress?.finished)}
        hint={data ? 'Validées, en échec ou annulées.' : why}
      />
      <MissionKpiTile label="Tâches restantes" icon={ClockIcon} hue="amber" value={pick(progress?.remaining)} hint={why} />
      <MissionKpiTile label="Tâches totales" icon={ColumnsIcon} hue="indigo" value={pick(progress?.total)} hint={why} />
    </MissionKpiGrid>
  )
}
