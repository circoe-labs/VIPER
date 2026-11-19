import type { MouseEvent, ReactNode } from 'react'
import { Link, useNavigate } from 'react-router'

import { type MissionCard, useSetMissionStatus } from '../api/missions'
import { StatusBadge } from '../ui/Badge'
import { IconButton } from '../ui/Button'
import { Switch } from '../ui/fields'
import type { Point } from '../ui/floating'
import { AlertIcon, CheckCircleIcon, ClockIcon, LockIcon, MoreIcon, TargetIcon, UsersIcon } from '../ui/icons'
import { Tooltip } from '../ui/Tooltip'
import { MissionMark } from './CategoryGlyph'
import { categoryAccent } from './categoryVisual'
import { MissionLiveAgents } from './MissionLiveAgents'
import { MissionStatusChip } from './MissionStatusChip'
import { agentLabel, plural, progressPercent } from './missionsListModel'
import { MISSION_TYPE_LABELS, momentLabel, recurrenceLabel, relativeMomentLabel } from './labels'
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

// « N à valider » / « N à relire »: the same notion (results waiting for a review), one link to the mission's Résultats
// tab. It sits above the card's stretched link (see `.mlist-above`).
function PendingLink({ card, children }: { card: MissionCard; children: ReactNode }) {
  return (
    <Link
      to={`/missions/${card.id}?tab=results`}
      className="mlist-pending mlist-above"
      aria-label={`${String(card.results_pending)} à valider : ouvrir les résultats`}
    >
      {children}
    </Link>
  )
}

// Everything about the last and next run, in one tooltip instead of lines of text on the card.
function runDetails(card: MissionCard): string[] {
  const last = momentLabel(card.last_run_at)
  const next = momentLabel(card.next_run_at)
  const failed = card.last_run_status === 'failed'
  const lines = [
    last
      ? `Dernière exécution : ${last}${failed ? ' (échec)' : ''}${card.last_run_results > 0 ? ` · ${plural(card.last_run_results, 'résultat')}` : ''}`
      : 'Jamais exécutée',
  ]
  if (failed) lines.push('Aucune tâche créée : la raison est notée dans la mission.')
  lines.push(recurrenceLabel(card))
  lines.push(next ? `Prochaine : ${next}` : card.status === 'paused' ? 'Inactive : fermée aux agents' : 'Aucune exécution prévue')
  return lines
}

// One compact line (icon + « il y a 3 j »); the details are in the tooltip, and a click still opens the mission.
function CardFoot({ card, lines, short }: { card: MissionCard; lines: string[]; short: string }) {
  const navigate = useNavigate()
  const failed = card.last_run_status === 'failed'
  return (
    <div
      className="mlist-card__foot mlist-above"
      onClick={() => {
        void navigate(`/missions/${card.id}`)
      }}
    >
      <Tooltip
        className={`mlist-card__run${failed ? ' is-failed' : ''}`}
        content={
          <span className="mlist-tip">
            {lines.map((line) => (
              <span key={line}>{line}</span>
            ))}
          </span>
        }
      >
        {failed ? <AlertIcon size={16} /> : <ClockIcon size={16} />}
        <span>{short}</span>
      </Tooltip>
    </div>
  )
}

function PendingFact({ card }: { card: MissionCard }) {
  return (
    <li className="mlist-fact">
      <CheckCircleIcon size={16} />
      {card.results_pending > 0 ? (
        <PendingLink card={card}>{String(card.results_pending)} à valider</PendingLink>
      ) : (
        '0 à valider'
      )}
    </li>
  )
}

function PendingChip({ card }: { card: MissionCard }) {
  if (card.results_pending === 0) return null
  return (
    <PendingLink card={card}>
      <StatusBadge tone="warning">{String(card.results_pending)} à relire</StatusBadge>
    </PendingLink>
  )
}

// The permanent « Dépôt » mission: always open to the agents, no switch and no menu (it cannot be edited, paused or
// deleted). Its « executions » are the drops an agent made on a person's direct request.
function DepositCardTile({ card }: { card: MissionCard }) {
  const last = momentLabel(card.last_run_at)
  return (
    <div className="mlist-item">
      <article
        className="mlist-card mlist-card--deposit mui-accent"
        data-hue={card.category ? undefined : 'neutral'}
        style={categoryAccent(card.category?.color)}
      >
        <div className="mlist-card__head">
          <MissionMark category={card.category} type={card.type} size={76} />
          <div className="mlist-card__id">
            <p className="mlist-card__kind">Mission permanente</p>
            <h2 className="mlist-card__title">
              <Link to={`/missions/${card.id}`} className="mlist-card__link">
                {card.name}
              </Link>
            </h2>
          </div>
        </div>
        <div className="mlist-card__chips">
          <StatusBadge tone="neutral" icon={LockIcon}>
            Permanente
          </StatusBadge>
          <PendingChip card={card} />
        </div>
        <ul className="mlist-card__facts">
          <li className="mlist-fact">
            <TargetIcon size={16} />
            {plural(card.runs_count, 'dépôt')}
          </li>
          <PendingFact card={card} />
        </ul>
        <CardFoot
          card={card}
          lines={[last ? `Dernier dépôt : ${last}` : 'Aucun dépôt pour l’instant', 'Toujours ouverte aux agents']}
          short={relativeMomentLabel(card.last_run_at) ?? 'Aucun dépôt'}
        />
      </article>
    </div>
  )
}

// One mission as a card: identity (icon, title, type, status), progress, the three facts, agents at work, last run.
// The title link is stretched over the card (`::after`), so the whole card opens the mission while the « à valider »
// link, the foot, the agent chips, the switch and the « … » button stay above it: no interactive element is nested.
export function MissionCardTile({ card, onMenu }: { card: MissionCard; onMenu: OpenMenu }) {
  if (card.is_deposit) return <DepositCardTile card={card} />
  const ago = relativeMomentLabel(card.last_run_at)
  const failed = card.last_run_status === 'failed'
  return (
    <div className="mlist-item">
      <article
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
              <Link to={`/missions/${card.id}`} className="mlist-card__link">
                {card.name}
              </Link>
            </h2>
          </div>
        </div>
        <div className="mlist-card__chips">
          <MissionStatusChip status={card.status} />
          <PendingChip card={card} />
        </div>
        <Progress card={card} />
        <ul className="mlist-card__facts">
          <li className="mlist-fact">
            <TargetIcon size={16} />
            {plural(card.tasks_total, 'tâche')}
          </li>
          <PendingFact card={card} />
          <li className="mlist-fact" title="Agent configuré pour cette mission">
            <UsersIcon size={16} />
            {agentLabel(card)}
          </li>
        </ul>
        <MissionLiveAgents agents={card.live_agents} />
        <CardFoot
          card={card}
          lines={runDetails(card)}
          short={ago ? `${failed ? 'Échec · ' : ''}${ago}` : 'Jamais exécutée'}
        />
      </article>
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
