import { useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router'

import { useMission, useRunMission, useSetMissionStatus } from '../api/missions'
import { TASK_STATUS_LABELS, TASK_STATUS_TONES, TASK_TYPE_LABELS } from '../agents/labels'
import { ReviewDialog } from '../agents/ReviewDialog'
import { StatusBadge } from '../ui/Badge'
import { Button } from '../ui/Button'
import { Card } from '../ui/Card'
import { EmptyState } from '../ui/EmptyState'
import { PageHeader } from '../ui/PageHeader'
import { ArrowLeftIcon, BoltIcon, PencilIcon, SparklesIcon, TrashIcon } from '../ui/icons'
import { CreateMissionDialog } from './CreateMissionDialog'
import { DeleteMissionDialog } from './DeleteMissionDialog'
import {
  MISSION_STATUS_LABELS,
  MISSION_STATUS_TONES,
  MISSION_TYPE_LABELS,
  momentLabel,
  recurrenceLabel,
  RESULT_KIND_LABELS,
  RUN_STATUS_LABELS,
  RUN_STATUS_TONES,
} from './labels'
import './missions.css'

export function MissionDetailPage() {
  const { missionId } = useParams()
  const mission = useMission(missionId)
  const run = useRunMission(missionId ?? '')
  const setStatus = useSetMissionStatus(missionId ?? '')
  const navigate = useNavigate()
  const [reviewId, setReviewId] = useState<string | null>(null)
  const [editing, setEditing] = useState(false)
  const [deleting, setDeleting] = useState(false)

  if (mission.isLoading) {
    return <p className="missions-muted">Chargement…</p>
  }
  if (mission.isError || !mission.data) {
    return (
      <EmptyState
        icon={SparklesIcon}
        title="Mission introuvable"
        description="Elle a peut-être été supprimée."
        action={
          <Link to="/missions">
            <Button variant="secondary" icon={ArrowLeftIcon}>
              Retour aux missions
            </Button>
          </Link>
        }
      />
    )
  }

  const { card, targets, runs, tasks, prompt, result_kind, result_limit } = mission.data
  const open = card.status === 'active'
  const canRun = card.status === 'active' && targets.length > 0
  const closed = card.status === 'done' || card.status === 'cancelled'

  return (
    <div className="missions">
      <Link to="/missions" className="missions-back">
        <ArrowLeftIcon size={16} /> Missions
      </Link>
      <PageHeader
        title={card.name}
        description={
          <span className="missions-detail__meta">
            <StatusBadge tone={MISSION_STATUS_TONES[card.status]}>
              {MISSION_STATUS_LABELS[card.status]}
            </StatusBadge>
            <span>
              {MISSION_TYPE_LABELS[card.type]} · {card.agent_label ?? 'Automatique'} · {recurrenceLabel(card)}
            </span>
          </span>
        }
        actions={
          <div className="missions-detail__actions">
            <Button
              icon={BoltIcon}
              disabled={!canRun}
              loading={run.isPending}
              title={canRun ? undefined : 'Ajoutez des données liées et activez la mission pour lancer une exécution.'}
              onClick={() => {
                run.mutate()
              }}
            >
              Lancer maintenant
            </Button>
            {open && (
              <Button
                variant="secondary"
                loading={setStatus.isPending}
                onClick={() => {
                  setStatus.mutate('paused')
                }}
              >
                Mettre en pause
              </Button>
            )}
            {card.status === 'paused' && (
              <Button
                variant="secondary"
                loading={setStatus.isPending}
                onClick={() => {
                  setStatus.mutate('active')
                }}
              >
                Reprendre
              </Button>
            )}
            <Button
              variant="secondary"
              icon={PencilIcon}
              disabled={closed}
              title={closed ? 'Mission terminée : créez-en une nouvelle.' : undefined}
              onClick={() => {
                setEditing(true)
              }}
            >
              Modifier
            </Button>
            <Button
              variant="secondary"
              icon={TrashIcon}
              onClick={() => {
                setDeleting(true)
              }}
            >
              Supprimer
            </Button>
          </div>
        }
      />
      {run.isError && <p className="missions-error">L’exécution n’a pas pu démarrer.</p>}
      {setStatus.isError && <p className="missions-error">Le statut n’a pas pu être changé.</p>}
      {editing && (
        <CreateMissionDialog
          open
          mission={mission.data}
          onClose={() => {
            setEditing(false)
          }}
        />
      )}
      <DeleteMissionDialog
        open={deleting}
        missionId={card.id}
        name={card.name}
        onClose={() => {
          setDeleting(false)
        }}
        onDeleted={() => {
          void navigate('/missions')
        }}
      />
      {card.results_pending > 0 && (
        <p className="missions-notice">
          {String(card.results_pending)} résultat{card.results_pending > 1 ? 's' : ''} attend
          {card.results_pending > 1 ? 'ent' : ''} votre relecture : ouvrez la tâche concernée.
        </p>
      )}

      <div className="missions-detail__grid">
        <Card title="Consigne">
          <p className="mission-prompt">{prompt}</p>
          <p className="missions-muted">
            Résultat attendu : {RESULT_KIND_LABELS[result_kind]} · limite {String(result_limit)} par exécution
          </p>
        </Card>
        <Card title={`Données liées (${String(targets.length)})`}>
          {targets.length === 0 ? (
            <p className="missions-muted">Aucune donnée liée : mission de découverte.</p>
          ) : (
            <ul className="mission-targets">
              {targets.map((target) => (
                <li key={`${target.kind}:${target.id}`} className="mission-target">
                  <span className="mission-target__kind">
                    {target.kind === 'company' ? 'Société' : 'Prospect'}
                  </span>
                  <span className="mission-target__label">{target.label}</span>
                  {target.hint && <span className="mission-target__hint">{target.hint}</span>}
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>

      <Card title={`Exécutions (${String(runs.length)})`}>
        {runs.length === 0 ? (
          <p className="missions-muted">Aucune exécution pour l’instant.</p>
        ) : (
          <ul className="mission-runs">
            {runs.map((item) => (
              <li key={item.id} className="mission-run">
                <span className="mission-run__when">{momentLabel(item.scheduled_at)}</span>
                <StatusBadge tone={RUN_STATUS_TONES[item.status]}>
                  {RUN_STATUS_LABELS[item.status]}
                </StatusBadge>
                <span className="mission-run__counts">
                  {String(item.tasks_total)} tâche{item.tasks_total > 1 ? 's' : ''} ·{' '}
                  {String(item.results_count)} résultat{item.results_count > 1 ? 's' : ''}
                </span>
                {item.note && <span className="mission-run__note">{item.note}</span>}
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card title="Tâches">
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
                <StatusBadge tone={TASK_STATUS_TONES[task.status]}>
                  {TASK_STATUS_LABELS[task.status]}
                </StatusBadge>
                <span className="mission-task__meta">
                  {task.claimed_by_label ?? 'libre'} · tentative {String(task.attempts)}/{String(task.max_attempts)}
                </span>
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
      </Card>

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
