import { useState } from 'react'

import { ReviewDialog } from '../agents/ReviewDialog'
import type { MissionDetail } from '../api/missions'
import { StatusBadge } from '../ui/Badge'
import { AlertIcon, BuildingIcon, CalendarIcon, SparklesIcon, TargetIcon, UsersIcon } from '../ui/icons'
import { InfoTip } from '../ui/InfoTip'
import { MissionPanel } from './MissionPanel'
import { MissionSourcesCard } from './MissionSourcesCard'
import { MissionTasksPanel } from './MissionTasksPanel'
import { plural } from './missionsListModel'
import { momentLabel, RESULT_KIND_LABELS, RUN_STATUS_LABELS, RUN_STATUS_TONES } from './labels'

interface MissionOverviewTabProps {
  mission: MissionDetail
}

// « Vue d'ensemble » body: configuration (consigne, linked data) then the runs and tasks history. The live strip is
// above the tabs (MissionLiveStrip); mission actions stay in the page header.
export function MissionOverviewTab({ mission }: MissionOverviewTabProps) {
  const [reviewId, setReviewId] = useState<string | null>(null)
  const { targets, runs, tasks, prompt, result_kind, rule } = mission
  const planned = rule.task_count

  return (
    <div className="missions mdet-overview">
      <div className="mdet-grid">
        <MissionPanel title="Consigne" icon={SparklesIcon} hue="purple" level={2}>
          <p className="mission-prompt">{prompt}</p>
          <p className="missions-muted">
            Résultat attendu : {RESULT_KIND_LABELS[result_kind]}
            {planned !== undefined && !mission.card.is_deposit && (
              <>
                {' · '}
                {plural(planned, 'tâche')}
                {mission.card.is_recurring && ' par exécution'}
              </>
            )}
          </p>
        </MissionPanel>
        <MissionPanel title={`Données liées (${String(targets.length)})`} icon={TargetIcon} hue="blue" level={2}>
          {targets.length === 0 ? (
            <p className="missions-muted">
              Aucune donnée liée.{' '}
              <InfoTip label="Aide : sans données liées">
                Seule une mission « Découvrir des sociétés » part de zéro ; les autres travaillent sur des fiches liées.
              </InfoTip>
            </p>
          ) : (
            <ul className="mission-targets">
              {targets.map((target) => (
                <li key={`${target.kind}:${target.id}`} className="mission-target">
                  <span
                    className="mission-target__icon"
                    role="img"
                    aria-label={target.kind === 'company' ? 'Société' : 'Prospect'}
                  >
                    {target.kind === 'company' ? <BuildingIcon size={14} /> : <UsersIcon size={14} />}
                  </span>
                  <span className="mission-target__label">{target.label}</span>
                  {target.hint && <span className="mission-target__hint">{target.hint}</span>}
                </li>
              ))}
            </ul>
          )}
        </MissionPanel>
      </div>

      <MissionSourcesCard mission={mission} />

      <MissionPanel title={`Exécutions (${String(runs.length)})`} icon={CalendarIcon} hue="teal" level={2}>
        {runs.length === 0 ? (
          <p className="missions-muted">Aucune exécution pour l’instant.</p>
        ) : (
          <ul className="mission-runs">
            {runs.map((item) => (
              <li key={item.id} className="mission-run">
                <span className="mission-run__when">{momentLabel(item.scheduled_at)}</span>
                <StatusBadge tone={RUN_STATUS_TONES[item.status]}>{RUN_STATUS_LABELS[item.status]}</StatusBadge>
                <span className="mission-run__counts">
                  {String(item.tasks_finished ?? 0)} / {plural(item.tasks_total, 'tâche')}{' '}
                  {item.tasks_total > 1 ? 'terminées' : 'terminée'} · {plural(item.results_count, 'résultat')}
                </span>
                {item.note && (
                  <span className={`mission-run__note${item.status === 'failed' ? ' is-failed' : ''}`}>
                    {item.status === 'failed' && <AlertIcon size={14} />}
                    {item.note}
                  </span>
                )}
              </li>
            ))}
          </ul>
        )}
      </MissionPanel>

      <MissionTasksPanel tasks={tasks} onReview={setReviewId} />

      <ReviewDialog
        key={reviewId ?? 'closed'}
        resultId={reviewId}
        onClose={() => {
          setReviewId(null)
        }}
      />
    </div>
  )
}
