import type { MissionStatistics } from '../api/missions'
import { CheckCircleIcon, ClockIcon, ColumnsIcon } from '../ui/icons'
import { MissionDonut } from './MissionDonut'
import { KpiCard, KpiGrid } from '../ui/KpiCard'
import { MissionPanel } from './MissionPanel'
import { useTableToggle } from './TableToggle'
import { formatCount, formatDuration, formatRate } from './statsModel'
import { resultsDonut, tasksDonut } from './statsSelectors'
import './statsPanels.css'

// « Résultats par statut »: whole-mission distribution of `results_by_status` (exclusive statuses) plus the two
// review figures the API computes: acceptance_rate (accepted / (accepted + rejected), null before any decision) and
// avg_review_seconds (submission -> decision, i.e. REVIEW latency, not processing time).
export function StatsResultsPanel({ stats }: { stats: MissionStatistics }) {
  const decided = stats.results_by_status.accepted + stats.results_by_status.rejected
  const { asTable, button } = useTableToggle()
  return (
    <MissionPanel title="Résultats par statut" icon={CheckCircleIcon} hue="success" actions={button}>
      <MissionDonut
        title="Résultats par statut"
        segments={resultsDonut(stats)}
        unit="résultats"
        asTable={asTable}
        emptyText="Aucun résultat déposé pour l’instant."
      />
      <KpiGrid label="Relecture des résultats" columns={2}>
        <KpiCard
          label="Taux d’acceptation"
          icon={CheckCircleIcon}
          value={stats.acceptance_rate === null ? null : formatRate(stats.acceptance_rate)}
          hint={
            stats.acceptance_rate === null
              ? 'Aucun résultat décidé pour l’instant.'
              : `Sur ${formatCount(decided)} résultat(s) acceptés ou refusés.`
          }
          tone="success"
        />
        <KpiCard
          label="Délai moyen de relecture"
          icon={ClockIcon}
          value={stats.avg_review_seconds === null ? null : formatDuration(stats.avg_review_seconds)}
          hint={stats.avg_review_seconds === null ? 'Aucun résultat décidé pour l’instant.' : 'Du dépôt à la décision.'}
          tone="warning"
        />
      </KpiGrid>
    </MissionPanel>
  )
}

// « Tâches par statut »: whole-mission distribution of `tasks_by_status`.
export function StatsTasksPanel({ stats }: { stats: MissionStatistics }) {
  const { asTable, button } = useTableToggle()
  return (
    <MissionPanel title="Tâches par statut" icon={ColumnsIcon} hue="indigo" actions={button}>
      <MissionDonut
        title="Tâches par statut"
        segments={tasksDonut(stats)}
        unit="tâches"
        asTable={asTable}
        emptyText="Aucune tâche pour l’instant."
      />
    </MissionPanel>
  )
}
