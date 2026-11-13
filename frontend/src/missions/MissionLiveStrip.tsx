import type { UseQueryResult } from '@tanstack/react-query'

import type { MissionOverview } from '../api/missions'
import { StatusBadge } from '../ui/Badge'
import { Button } from '../ui/Button'
import { AlertIcon, RefreshIcon } from '../ui/icons'
import { ScoreRing } from '../ui/ScoreRing'
import { relativeMomentLabel } from './labels'
import './missionDetail.css'

interface MissionLiveStripProps {
  overview: UseQueryResult<MissionOverview>
  // Jump to the Résultats tab (pending reviews badge).
  onOpenResults: () => void
}

function agentsText(overview: MissionOverview): string {
  const { active_agents: count, agents } = overview
  if (count === 0) return 'Aucun'
  const first = agents[0]
  if (!first) return String(count)
  return count > 1 ? `${String(count)} · ${first.agent_label} et d’autres` : `1 · ${first.agent_label}`
}

// Live supervision strip, shown above every tab. Driven only by the overview query (polled by the shell while the
// page is visible). Every state is explicit: loading, error (with retry), nothing yet, live, stale-after-error.
export function MissionLiveStrip({ overview, onOpenResults }: MissionLiveStripProps) {
  const { data } = overview

  if (!data) {
    if (overview.isError) {
      return (
        <div className="mdet-live mdet-live--error" role="status">
          <AlertIcon size={18} />
          <span>Le suivi en direct est indisponible.</span>
          <Button
            size="sm"
            variant="secondary"
            icon={RefreshIcon}
            loading={overview.isFetching}
            onClick={() => {
              void overview.refetch()
            }}
          >
            Réessayer
          </Button>
        </div>
      )
    }
    return (
      <p className="mdet-live mdet-live--loading" role="status">
        Chargement du suivi en direct…
      </p>
    )
  }

  const { tasks } = data
  const noRun = data.current_run === null && tasks.total === 0
  const percent = tasks.total === 0 ? 0 : Math.round((tasks.finished / tasks.total) * 100)
  const lastActivity = relativeMomentLabel(data.last_activity_at)

  return (
    <section className="mdet-live" aria-label="Suivi en direct">
      {noRun ? (
        <p className="mdet-live__empty">
          Aucune exécution pour l’instant : le suivi en direct apparaît dès le premier lancement.
        </p>
      ) : (
        <dl className="mdet-live__stats">
          <div className="mdet-live__stat">
            <dt>Agents actifs</dt>
            <dd>
              <span className={`mdet-live__dot${data.active_agents > 0 ? ' is-live' : ''}`} aria-hidden="true" />
              {agentsText(data)}
            </dd>
          </div>
          <div className="mdet-live__stat">
            <dt>Dernière activité</dt>
            <dd>{lastActivity ?? 'Aucune pour l’instant'}</dd>
          </div>
          <div className="mdet-live__stat mdet-live__stat--progress">
            <dt>Progression</dt>
            <dd>
              {tasks.total > 0 && <ScoreRing value={percent} tone={percent === 100 ? 'success' : 'neutral'} />}
              <span className="mdet-live__progress-text">
                <span>
                  {tasks.total === 0
                    ? 'Aucune tâche'
                    : `${String(tasks.finished)} / ${String(tasks.total)} tâche${tasks.total > 1 ? 's' : ''} traitée${tasks.total > 1 ? 's' : ''}`}
                </span>
                <progress
                  className="mdet-live__progress"
                  max={Math.max(tasks.total, 1)}
                  value={tasks.finished}
                  aria-label={`Progression : ${String(percent)} %`}
                />
              </span>
            </dd>
          </div>
        </dl>
      )}
      {data.pending_reviews > 0 && (
        <button type="button" className="mdet-live__reviews" onClick={onOpenResults}>
          <StatusBadge tone="warning" strong>
            {String(data.pending_reviews)} résultat{data.pending_reviews > 1 ? 's' : ''} à relire
          </StatusBadge>
        </button>
      )}
      {overview.isError && (
        <p className="mdet-live__stale" role="status">
          Actualisation impossible : dernières données connues affichées.
        </p>
      )}
      {data.warnings.map((warning) => (
        <p key={warning.code} className="missions-banner" role="status">
          <AlertIcon size={18} />
          {warning.message}
        </p>
      ))}
    </section>
  )
}
