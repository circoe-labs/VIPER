import type { UseQueryResult } from '@tanstack/react-query'

import type { MissionOverview } from '../api/missions'
import { CheckCircleIcon, ClockIcon, ColumnsIcon, UsersIcon } from '../ui/icons'
import { KpiCard, KpiGrid } from '../ui/KpiCard'
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
    <KpiGrid label="Indicateurs d’exécution de la mission" columns={2}>
      <KpiCard
        label="Agents actifs"
        icon={UsersIcon}
        tone="info"
        value={pick(data?.active_agents)}
        hint={data ? 'Avec une session active maintenant.' : why}
      />
      <KpiCard
        label="Tâches traitées"
        icon={CheckCircleIcon}
        tone="success"
        value={pick(progress?.finished)}
        hint={data ? 'Validées, en échec ou annulées.' : why}
      />
      <KpiCard label="Tâches restantes" icon={ClockIcon} tone="warning" value={pick(progress?.remaining)} hint={why} />
      <KpiCard label="Tâches totales" icon={ColumnsIcon} value={pick(progress?.total)} hint={why} />
    </KpiGrid>
  )
}
