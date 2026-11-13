import type { MissionDetail } from '../api/missions'
import { Badge } from '../ui/Badge'
import { Button } from '../ui/Button'
import { MapPinIcon, PauseIcon, PencilIcon, PlayIcon, TrashIcon } from '../ui/icons'
import { MISSION_TYPE_LABELS, recurrenceLabel } from './labels'
import { MissionStatusChip } from './MissionStatusChip'
import { accentForMission, MISSION_TYPE_ICONS } from './missionAccent'
import './missionUi.css'
import './missionDetail.css'

interface MissionHeaderProps {
  mission: MissionDetail
  statusPending: boolean
  onToggleStatus: () => void
  onEdit: () => void
  onDelete: () => void
}

// Header of the mission detail (R2): accent icon tile + the single h1, then status / type / recurrence / place /
// agent chips, then the lifecycle actions. Behaviour is the former page header's, unchanged: pause/activate is hidden
// on a closed mission, « Modifier » is disabled once closed, « Supprimer » stays available. Status colour is the
// semantic `MissionStatusChip`; the tile accent is decoration only. The place chip exists only when the rule has one.
export function MissionHeader({ mission, statusPending, onToggleStatus, onEdit, onDelete }: MissionHeaderProps) {
  const { card, rule } = mission
  const TypeIcon = MISSION_TYPE_ICONS[card.type]
  const open = card.status === 'active'
  const closed = card.status === 'done' || card.status === 'cancelled'
  const place = rule.geography?.trim() ?? ''

  return (
    <header className="mdet-header" data-hue={accentForMission(card.id)}>
      <span className="mui-icon-tile mdet-header__tile" aria-hidden="true">
        <TypeIcon size={22} />
      </span>
      <div className="mdet-header__text">
        <h1 className="mdet-header__title">{card.name}</h1>
        <ul className="mdet-header__chips" aria-label="Caractéristiques de la mission">
          <li>
            <MissionStatusChip status={card.status} />
          </li>
          <li>
            <Badge>{MISSION_TYPE_LABELS[card.type]}</Badge>
          </li>
          <li>
            <Badge>{recurrenceLabel(card)}</Badge>
          </li>
          {place && (
            <li>
              <Badge icon={MapPinIcon}>{place}</Badge>
            </li>
          )}
          <li>
            <Badge>{card.agent_label ?? 'Automatique'}</Badge>
          </li>
        </ul>
      </div>
      <div className="mdet-header__actions">
        {!closed && (
          <Button
            variant={open ? 'secondary' : 'primary'}
            icon={open ? PauseIcon : PlayIcon}
            loading={statusPending}
            title={open ? 'Les agents ne reçoivent plus ses tâches.' : 'Ses tâches redeviennent accessibles aux agents.'}
            onClick={onToggleStatus}
          >
            {open ? 'Désactiver' : 'Activer'}
          </Button>
        )}
        <Button
          variant="secondary"
          icon={PencilIcon}
          disabled={closed}
          title={closed ? 'Mission terminée : créez-en une nouvelle.' : undefined}
          onClick={onEdit}
        >
          Modifier
        </Button>
        <Button variant="danger" icon={TrashIcon} onClick={onDelete}>
          Supprimer
        </Button>
      </div>
    </header>
  )
}
