import { useState } from 'react'

import { TASK_STATUS_LABELS, TASK_STATUS_TONES, TASK_TYPE_LABELS } from '../agents/labels'
import { ReviewDialog } from '../agents/ReviewDialog'
import type { MissionDetail } from '../api/missions'
import { StatusBadge } from '../ui/Badge'
import { Button } from '../ui/Button'
import { AlertIcon, BoltIcon, BuildingIcon, CalendarIcon, SparklesIcon, TargetIcon, UsersIcon } from '../ui/icons'
import { InfoTip } from '../ui/InfoTip'
import { MissionPanel } from './MissionPanel'
import { MissionSourcesCard } from './MissionSourcesCard'
import { momentLabel, RESULT_KIND_LABELS, RUN_STATUS_LABELS, RUN_STATUS_TONES } from './labels'

interface MissionOverviewTabProps {
  mission: MissionDetail
}

// « Vue d'ensemble » body: configuration (consigne, linked data) then the runs and tasks history. The live strip is
// above the tabs (MissionLiveStrip); mission actions stay in the page header.
export function MissionOverviewTab({ mission }: MissionOverviewTabProps) {
  const [reviewId, setReviewId] = useState<string | null>(null)
  const { targets, runs, tasks, prompt, result_kind, result_limit } = mission

  return (
    <div className="missions mdet-overview">
      <div className="mdet-grid">
        <MissionPanel title="Consigne" icon={SparklesIcon} hue="purple" level={2}>
          <p className="mission-prompt">{prompt}</p>
          <p className="missions-muted">
            Résultat attendu : {RESULT_KIND_LABELS[result_kind]} · limite {String(result_limit)} par exécution
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
                  {String(item.tasks_total)} tâche{item.tasks_total > 1 ? 's' : ''} · {String(item.results_count)}{' '}
                  résultat{item.results_count > 1 ? 's' : ''}
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

      <MissionPanel title="Tâches" icon={BoltIcon} hue="amber" level={2}>
        {tasks.length === 0 ? (
          <p className="missions-muted">Aucune tâche : lancez la mission pour en créer.</p>
        ) : (
          <ul className="mission-tasks">
            {tasks.map((task) => (
              <li key={task.id} className="mission-task">
                <div className="mission-task__main">
                  <span className="mission-task__type">{TASK_TYPE_LABELS[task.type]}</span>
                  {task.prospect_name && <span className="mission-task__target">{task.prospect_name}</span>}
                </div>
                <StatusBadge tone={TASK_STATUS_TONES[task.status]}>{TASK_STATUS_LABELS[task.status]}</StatusBadge>
                <span className="mission-task__meta">{task.claimed_by_label ?? 'libre'}</span>
                {task.result_id && (
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={() => {
                      setReviewId(task.result_id)
                    }}
                  >
                    Relire
                  </Button>
                )}
              </li>
            ))}
          </ul>
        )}
      </MissionPanel>

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
