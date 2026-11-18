import type { MouseEvent } from 'react'
import { Link } from 'react-router'

import { type MissionCard, useSetMissionStatus } from '../api/missions'
import { StatusBadge } from '../ui/Badge'
import { IconButton } from '../ui/Button'
import { Switch } from '../ui/fields'
import type { Point } from '../ui/floating'
import { AlertIcon, CheckCircleIcon, ClockIcon, LockIcon, MoreIcon, TargetIcon, UsersIcon } from '../ui/icons'
import { MissionMark } from './CategoryGlyph'
import { categoryAccent } from './categoryVisual'
import { MissionStatusChip } from './MissionStatusChip'
import { agentLabel, plural, progressPercent } from './missionsListModel'
import { MISSION_TYPE_LABELS, momentLabel, recurrenceLabel } from './labels'
import './missionsList.css'

// A right-click on the card, or its « … » button (keyboard, touch), asks for the mission's menu at a point.
export type OpenMenu = (card: MissionCard, position: Point, alignRight: boolean) => void

// Active: its tasks are open to the agents that connect; inactive: they are no longer offered. The word next to the
// switch is the status chip of the card, so the label is only read by assistive technology.
function ActiveSwitch({ card }: { card: MissionCard }) {
  const setStatus = useSetMissionStatus(card.id)
  const active = card.status === 'active'
  return (
    <Switch
      className="mlist-switch"
      label={active ? 'Active' : 'Inactive'}
      aria-label={`Mission ${card.name} active`}
      checked={active}
      disabled={setStatus.isPending}
      onChange={() => {
        setStatus.mutate(active ? 'paused' : 'active')
      }}
    />
  )
}

function Progress({ card }: { card: MissionCard }) {
  const percent = progressPercent(card)
  if (percent === null) return <p className="mlist-progress mlist-progress--none">Aucune tâche</p>
  return (
    <div className="mlist-progress">
      <progress
        className="mlist-progress__bar"
        value={percent}
        max={100}
        aria-label={`Progression : ${String(percent)} % des tâches validées`}
      />
      <span className="mlist-progress__figure">
        <strong>{String(percent)} %</strong> validées
      </span>
    </div>
  )
}

// The permanent « Dépôt » mission: always open to the agents, no switch and no menu (it cannot be edited, paused or
// deleted). Its « executions » are the drops an agent made on a person's direct request.
function DepositCardTile({ card }: { card: MissionCard }) {
  const last = momentLabel(card.last_run_at)
  return (
    <div className="mlist-item">
      <Link
        to={`/missions/${card.id}`}
        className="mlist-card mlist-card--deposit mui-accent"
        data-hue={card.category ? undefined : 'neutral'}
        style={categoryAccent(card.category?.color)}
      >
        <div className="mlist-card__head">
          <MissionMark category={card.category} type={card.type} size={76} />
          <div className="mlist-card__id">
            <p className="mlist-card__kind">Mission permanente</p>
            <h2 className="mlist-card__title">{card.name}</h2>
          </div>
        </div>
        <div className="mlist-card__chips">
          <StatusBadge tone="neutral" icon={LockIcon}>
            Permanente
          </StatusBadge>
          {card.results_pending > 0 && <StatusBadge tone="warning">{String(card.results_pending)} à relire</StatusBadge>}
        </div>
        <p className="mlist-deposit__about">Les données qu’un agent dépose sur demande directe, hors de toute mission.</p>
        <ul className="mlist-card__facts">
          <li className="mlist-fact">
            <TargetIcon size={16} />
            {plural(card.runs_count, 'dépôt')}
          </li>
          <li className="mlist-fact">
            <CheckCircleIcon size={16} />
            {String(card.results_pending)} à valider
          </li>
        </ul>
        <div className="mlist-card__foot">
          <p className="mlist-card__run">
            <ClockIcon size={16} />
            <span>{last ? `Dernier dépôt : ${last}` : 'Aucun dépôt pour l’instant'}</span>
          </p>
          <p className="mlist-card__plan">
            <span>Toujours ouverte aux agents</span>
          </p>
        </div>
      </Link>
    </div>
  )
}

// One mission as a card: identity (icon, title, type, status), progress, the three facts, last run. The whole card is
// a link; the switch and the « … » button sit beside it (never inside the <a>) so the nesting stays valid.
export function MissionCardTile({ card, onMenu }: { card: MissionCard; onMenu: OpenMenu }) {
  if (card.is_deposit) return <DepositCardTile card={card} />
  const last = momentLabel(card.last_run_at)
  const next = momentLabel(card.next_run_at)
  const failed = card.last_run_status === 'failed'
  return (
    <div className="mlist-item">
      <Link
        to={`/missions/${card.id}`}
        className="mlist-card mui-accent"
        data-hue={card.category ? undefined : 'neutral'}
        style={categoryAccent(card.category?.color)}
        onContextMenu={(event: MouseEvent) => {
          event.preventDefault()
          onMenu(card, { x: event.clientX, y: event.clientY }, false)
        }}
      >
        <div className="mlist-card__head">
          <MissionMark category={card.category} type={card.type} size={76} />
          <div className="mlist-card__id">
            <p className="mlist-card__kind">{card.category?.name ?? MISSION_TYPE_LABELS[card.type]}</p>
            <h2 className="mlist-card__title" title={card.prompt}>
              {card.name}
            </h2>
          </div>
        </div>
        <div className="mlist-card__chips">
          <MissionStatusChip status={card.status} />
          {card.results_pending > 0 && <StatusBadge tone="warning">{String(card.results_pending)} à relire</StatusBadge>}
        </div>
        <Progress card={card} />
        <ul className="mlist-card__facts">
          <li className="mlist-fact">
            <TargetIcon size={16} />
            {plural(card.tasks_total, 'tâche')}
          </li>
          <li className="mlist-fact">
            <CheckCircleIcon size={16} />
            {String(card.results_pending)} à valider
          </li>
          <li className="mlist-fact" title="Agent configuré pour cette mission">
            <UsersIcon size={16} />
            {agentLabel(card)}
          </li>
        </ul>
        <div className="mlist-card__foot">
          <p
            className={`mlist-card__run${failed ? ' is-failed' : ''}`}
            title={failed ? 'La dernière exécution n’a créé aucune tâche : la raison est notée dans la mission.' : undefined}
          >
            {failed ? <AlertIcon size={16} /> : <ClockIcon size={16} />}
            <span>
              {last ? `Dernière exécution : ${last}` : 'Jamais exécutée'}
              {failed && ' (échec)'}
              {card.last_run_results > 0 && ` · ${plural(card.last_run_results, 'résultat')}`}
            </span>
          </p>
          <p className="mlist-card__plan">
            <span>{recurrenceLabel(card)}</span>
            <span>
              {next ? `Prochaine : ${next}` : card.status === 'paused' ? 'Inactive : fermée aux agents' : 'Aucune exécution prévue'}
            </span>
          </p>
        </div>
      </Link>
      <div className="mlist-item__actions">
        {(card.status === 'active' || card.status === 'paused') && <ActiveSwitch card={card} />}
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
    </div>
  )
}
