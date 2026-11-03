import { type MouseEvent, useState } from 'react'
import { Link, useNavigate } from 'react-router'

import {
  type MissionCard,
  type MissionStatus,
  useMission,
  useMissionProposals,
  useMissions,
  useSetMissionStatus,
} from '../api/missions'
import { StatusBadge } from '../ui/Badge'
import { TASK_TYPE_LABELS } from '../agents/labels'
import { ReviewDialog } from '../agents/ReviewDialog'
import { Button, IconButton } from '../ui/Button'
import { Card } from '../ui/Card'
import { EmptyState } from '../ui/EmptyState'
import { PageHeader } from '../ui/PageHeader'
import type { Point } from '../ui/floating'
import {
  AlertIcon,
  ClockIcon,
  LinkIcon,
  MoreIcon,
  PencilIcon,
  PlayIcon,
  PlusIcon,
  RepeatIcon,
  SparklesIcon,
  TrashIcon,
} from '../ui/icons'
import { InfoTip } from '../ui/InfoTip'
import { Menu } from '../ui/Menu'
import { CreateMissionDialog } from './CreateMissionDialog'
import { DeleteMissionDialog } from './DeleteMissionDialog'
import {
  MISSION_STATUS_ICONS,
  MISSION_STATUS_LABELS,
  MISSION_STATUS_TONES,
  MISSION_TYPE_LABELS,
  momentLabel,
  recurrenceLabel,
} from './labels'
import './missions.css'

const FILTERS: { id: 'all' | MissionStatus; label: string }[] = [
  { id: 'all', label: 'Toutes' },
  { id: 'active', label: 'Actives' },
  { id: 'paused', label: 'En pause' },
  { id: 'done', label: 'Terminées' },
]

// A right-click on the card, or its « … » button (keyboard, touch), asks for the mission's menu at a point.
type OpenMenu = (card: MissionCard, position: Point, alignRight: boolean) => void

// « Reprendre » right on a paused card: a paused mission creates no task, so an agent asking for work finds none.
function ResumeButton({ card }: { card: MissionCard }) {
  const setStatus = useSetMissionStatus(card.id)
  return (
    <Button
      size="sm"
      variant="primary"
      icon={PlayIcon}
      className="mission-card__resume"
      loading={setStatus.isPending}
      aria-label={`Reprendre la mission ${card.name}`}
      onClick={() => {
        setStatus.mutate('active')
      }}
    >
      Reprendre
    </Button>
  )
}

function MissionTile({ card, onMenu }: { card: MissionCard; onMenu: OpenMenu }) {
  const last = momentLabel(card.last_run_at)
  const next = momentLabel(card.next_run_at)
  const failed = card.last_run_status === 'failed'
  return (
    <>
      <Link
        to={`/missions/${card.id}`}
        className="mission-card"
        onContextMenu={(event: MouseEvent) => {
          event.preventDefault()
          onMenu(card, { x: event.clientX, y: event.clientY }, false)
        }}
      >
        <div className="mission-card__head">
          <h2 className="mission-card__title">{card.name}</h2>
          <StatusBadge tone={MISSION_STATUS_TONES[card.status]} icon={MISSION_STATUS_ICONS[card.status]}>
            {MISSION_STATUS_LABELS[card.status]}
          </StatusBadge>
        </div>
        <p className="mission-card__meta">
          {MISSION_TYPE_LABELS[card.type]} · {card.agent_label ?? 'Automatique'}
        </p>
        <p className="mission-card__prompt">{card.prompt}</p>
        <p className="mission-card__facts">
          <span className="mission-card__fact">
            <LinkIcon size={14} />
            {String(card.targets_count)} donnée{card.targets_count > 1 ? 's' : ''} liée
            {card.targets_count > 1 ? 's' : ''}
          </span>
          <span className="mission-card__fact">
            {card.is_recurring ? <RepeatIcon size={14} /> : <PlayIcon size={14} />}
            {recurrenceLabel(card)}
          </span>
        </p>
        <p
          className={`mission-card__run${failed ? ' is-failed' : ''}`}
          title={failed ? 'La dernière exécution n’a créé aucune tâche : la raison est notée dans la mission.' : undefined}
        >
          {failed ? <AlertIcon size={14} /> : <ClockIcon size={14} />}
          {last ? `Dernière exécution : ${last}` : 'Jamais exécutée'}
          {failed && ' (échec)'}
          {card.last_run_results > 0 && ` · ${String(card.last_run_results)} résultat${card.last_run_results > 1 ? 's' : ''}`}
        </p>
        <p className="mission-card__run">
          <ClockIcon size={14} />
          {next ? `Prochaine : ${next}` : card.status === 'paused' ? 'En pause : aucune exécution prévue' : 'Aucune exécution prévue'}
        </p>
        {card.results_pending > 0 && (
          <p className="mission-card__todo">
            {String(card.results_pending)} résultat{card.results_pending > 1 ? 's' : ''} à relire
          </p>
        )}
      </Link>
      <div className="mission-card__actions">
        {card.status === 'paused' && <ResumeButton card={card} />}
        <IconButton
          size="sm"
          icon={MoreIcon}
          label={`Actions de la mission ${card.name}`}
          onClick={(event) => {
            const box = event.currentTarget.getBoundingClientRect()
            onMenu(card, { x: box.right, y: box.bottom }, true)
          }}
        />
      </div>
    </>
  )
}

// « Modifier… » from the list: the form needs the whole rule, read first.
function EditMission({ id, onClose }: { id: string; onClose: () => void }) {
  const mission = useMission(id)
  if (mission.isError) {
    return (
      <p className="missions-error" role="alert">
        La mission n’a pas pu être chargée pour la modifier.
      </p>
    )
  }
  if (!mission.data) return null
  return <CreateMissionDialog open mission={mission.data} onClose={onClose} />
}

export function MissionsPage() {
  const [filter, setFilter] = useState<'all' | MissionStatus>('all')
  const [creating, setCreating] = useState(false)
  const missions = useMissions(filter === 'all' ? undefined : filter)
  const proposals = useMissionProposals()
  const [reviewId, setReviewId] = useState<string | null>(null)
  const [menu, setMenu] = useState<{ card: MissionCard; position: Point; alignRight: boolean } | null>(null)
  const [editId, setEditId] = useState<string | null>(null)
  const [deleting, setDeleting] = useState<MissionCard | null>(null)
  const navigate = useNavigate()
  const cards = missions.data?.items ?? []
  const openMenu: OpenMenu = (card, position, alignRight) => {
    setMenu({ card, position, alignRight })
  }

  return (
    <div className="missions">
      <PageHeader
        title="Missions"
        description={
          <span className="missions-detail__meta">
            Ce que vous confiez aux agents.
            <InfoTip label="Aide : missions">
              Une mission = une consigne, des données VIPER, une exécution. Chaque exécution crée des tâches que les agents
              connectés (Claude, ChatGPT…) prennent ; leurs propositions attendent votre relecture, rien n’est écrit sans
              votre validation.
            </InfoTip>
          </span>
        }
        actions={
          <Button
            variant="primary"
            icon={PlusIcon}
            onClick={() => {
              setCreating(true)
            }}
          >
            Nouvelle mission
          </Button>
        }
      />
      {(proposals.data?.length ?? 0) > 0 && (
        <Card title={`Propositions à relire (${String(proposals.data?.length ?? 0)})`}>
          <ul className="mission-proposals">
            {(proposals.data ?? []).map((proposal) => (
              <li key={proposal.result_id} className="mission-proposal">
                <span className="mission-proposal__subject">
                  {proposal.subject_label ?? TASK_TYPE_LABELS[proposal.task_type]}
                </span>
                <span className="mission-proposal__meta">
                  {proposal.submitted_by_label} · {momentLabel(proposal.submitted_at)}
                </span>
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() => {
                    setReviewId(proposal.result_id)
                  }}
                >
                  Relire
                </Button>
              </li>
            ))}
          </ul>
        </Card>
      )}
      <div className="missions__filters" role="group" aria-label="Filtrer les missions">
        {FILTERS.map((item) => (
          <Button
            key={item.id}
            size="sm"
            variant={filter === item.id ? 'primary' : 'secondary'}
            aria-pressed={filter === item.id}
            onClick={() => {
              setFilter(item.id)
            }}
          >
            {item.label}
          </Button>
        ))}
      </div>
      {missions.isLoading && <p className="missions-muted">Chargement…</p>}
      {missions.isError && <p className="missions-error">Les missions n’ont pas pu être chargées.</p>}
      {missions.isSuccess && cards.length === 0 && (
        <EmptyState
          icon={SparklesIcon}
          title="Aucune mission"
          description="Créez une mission : une consigne, des fiches liées, et les agents travaillent pendant que vous relisez les résultats."
          action={
            <Button
              variant="primary"
              icon={PlusIcon}
              onClick={() => {
                setCreating(true)
              }}
            >
              Nouvelle mission
            </Button>
          }
        />
      )}
      {cards.length > 0 && (
        <ul className="mission-cards">
          {cards.map((card) => (
            <li key={card.id} className="mission-cards__item">
              <MissionTile card={card} onMenu={openMenu} />
            </li>
          ))}
        </ul>
      )}
      <CreateMissionDialog
        open={creating}
        onClose={() => {
          setCreating(false)
        }}
      />
      {menu && (
        <Menu
          label={`Actions de la mission ${menu.card.name}`}
          position={menu.position}
          alignRight={menu.alignRight}
          onClose={() => {
            setMenu(null)
          }}
          sections={[
            {
              items: [
                {
                  id: 'open',
                  label: 'Ouvrir',
                  onSelect: () => {
                    void navigate(`/missions/${menu.card.id}`)
                  },
                },
                {
                  id: 'edit',
                  label: 'Modifier…',
                  icon: PencilIcon,
                  disabled: menu.card.status === 'done' || menu.card.status === 'cancelled',
                  title:
                    menu.card.status === 'done' || menu.card.status === 'cancelled'
                      ? 'Mission terminée : créez-en une nouvelle.'
                      : undefined,
                  onSelect: () => {
                    setEditId(menu.card.id)
                  },
                },
              ],
            },
            {
              items: [
                {
                  id: 'delete',
                  label: 'Supprimer…',
                  icon: TrashIcon,
                  danger: true,
                  onSelect: () => {
                    setDeleting(menu.card)
                  },
                },
              ],
            },
          ]}
        />
      )}
      {editId && (
        <EditMission
          key={editId}
          id={editId}
          onClose={() => {
            setEditId(null)
          }}
        />
      )}
      {deleting && (
        <DeleteMissionDialog
          key={deleting.id}
          open
          missionId={deleting.id}
          name={deleting.name}
          onClose={() => {
            setDeleting(null)
          }}
        />
      )}
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
