import type { UseQueryResult } from '@tanstack/react-query'

import type { MissionOverview } from '../api/missions'
import { Button } from '../ui/Button'
import { RefreshIcon, TargetIcon } from '../ui/icons'
import { ScoreRing } from '../ui/ScoreRing'
import { MissionPanel } from './MissionPanel'
import { formatCount } from './statsModel'
import { progressOf } from './statsSelectors'
import './statsPanels.css'

interface StatsProgressPanelProps {
  // Shared query of the mission page (`useMissionOverview`): same cache entry, no extra polling.
  overview: UseQueryResult<MissionOverview>
}

// « Progression de la mission »: finished tasks / total tasks (`overview.tasks`). « Traitées » = accepted + failed +
// cancelled, so the word « validées » is never used here (the list card counts the same finished tasks).
export function StatsProgressPanel({ overview }: StatsProgressPanelProps) {
  const data = overview.data
  return (
    <MissionPanel title="Progression de la mission" icon={TargetIcon} hue="purple" className="stp-progress">
      {!data && overview.isError && (
        <div className="mui-state stp-state" role="alert">
          <p>La progression est indisponible : les tâches de la mission n’ont pas pu être chargées.</p>
          <Button
            size="sm"
            icon={RefreshIcon}
            loading={overview.isFetching}
            onClick={() => {
              void overview.refetch()
            }}
          >
            Réessayer
          </Button>
        </div>
      )}
      {!data && !overview.isError && (
        <div aria-busy="true">
          <div className="mui-skeleton" />
          <p className="stp-muted" role="status">
            Chargement de la progression…
          </p>
        </div>
      )}
      {data && <ProgressBody overview={data} stale={overview.isError} />}
    </MissionPanel>
  )
}

function ProgressBody({ overview, stale }: { overview: MissionOverview; stale: boolean }) {
  const progress = progressOf(overview)
  return (
    <div className="stp-progress__body">
      {progress.percent === null ? (
        <p className="mui-state" role="status">
          Aucune tâche pour l’instant : la progression apparaîtra dès qu’une tâche sera créée.
        </p>
      ) : (
        <div className="stp-progress__main">
          <ScoreRing value={progress.percent} tone="success" size="lg" />
          <div className="stp-progress__text">
            <p className="stp-progress__caption">{String(progress.percent)} % des tâches traitées</p>
            <progress
              className="stp-progress__bar"
              max={progress.total}
              value={progress.finished}
              aria-label={`${String(progress.finished)} tâches traitées sur ${String(progress.total)}`}
            />
            <p className="stp-progress__count">
              {formatCount(progress.finished)} / {formatCount(progress.total)}
            </p>
            <p className="stp-muted">Traitées : validées, en échec ou annulées.</p>
          </div>
        </div>
      )}
      {stale && (
        <p className="stp-muted" role="status">
          Actualisation impossible : dernières données connues affichées.
        </p>
      )}
    </div>
  )
}
