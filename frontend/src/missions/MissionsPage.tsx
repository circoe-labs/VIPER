import { type MouseEvent, useState } from 'react'
import { Link, useNavigate } from 'react-router'

import { type MissionCard, type MissionStatus, useMission, useMissionProposals, useMissions } from '../api/missions'
import { StatusBadge } from '../ui/Badge'
import { TASK_TYPE_LABELS } from '../agents/labels'
import { ReviewDialog } from '../agents/ReviewDialog'
import { Button, IconButton } from '../ui/Button'
import { Card } from '../ui/Card'
import { EmptyState } from '../ui/EmptyState'
import { PageHeader } from '../ui/PageHeader'
import type { Point } from '../ui/floating'
import { MoreIcon, PencilIcon, PlusIcon, SparklesIcon, TrashIcon } from '../ui/icons'
import { Menu } from '../ui/Menu'
import { CreateMissionDialog } from './CreateMissionDialog'
import { DeleteMissionDialog } from './DeleteMissionDialog'
import {
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

function MissionTile({ card, onMenu }: { card: MissionCard; onMenu: OpenMenu }) {
  const last = momentLabel(card.last_run_at)
  const next = momentLabel(card.next_run_at)
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
          <StatusBadge tone={MISSION_STATUS_TONES[card.status]}>
            {MISSION_STATUS_LABELS[card.status]}
          </StatusBadge>
        </div>
        <p className="mission-card__meta">
          {MISSION_TYPE_LABELS[card.type]} · {card.agent_label ?? 'Automatique'}
        </p>
        <p className="mission-card__prompt">{card.prompt}</p>
        <p className="mission-card__facts">
          {String(card.targets_count)} donnée{card.targets_count > 1 ? 's' : ''} liée
          {card.targets_count > 1 ? 's' : ''} · {recurrenceLabel(card)}
        </p>
        <p className="mission-card__run">
          {last ? `Dernière exécution : ${last}` : 'Jamais exécutée'}
          {card.last_run_results > 0 && ` · ${String(card.last_run_results)} résultat${card.last_run_results > 1 ? 's' : ''}`}
        </p>
        <p className="mission-card__run">{next ? `Prochaine : ${next}` : 'Aucune exécution prévue'}</p>
        {card.results_pending > 0 && (
          <p className="mission-card__todo">
            {String(card.results_pending)} résultat{card.results_pending > 1 ? 's' : ''} à relire
          </p>
        )}
      </Link>
      <IconButton
        size="sm"
        icon={MoreIcon}
        label={`Actions de la mission ${card.name}`}
        className="mission-card__more"
        onClick={(event) => {
          const box = event.currentTarget.getBoundingClientRect()
          onMenu(card, { x: box.right, y: box.bottom }, true)
        }}
      />
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
        description="Ce que vous confiez aux agents : une consigne, des données VIPER, une exécution. Rien n’est écrit sans votre validation."
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
