import type { MissionType } from '../api/missions'
import {
  CompassIcon,
  type IconComponent,
  PencilIcon,
  RadarIcon,
  ShieldCheckIcon,
  SparklesIcon,
} from '../ui/icons'

// Mission UI hues (Slice 01 contract, tasks/viper_mission_ui_redesign/01-ui-contract/CONTRACT.md §2.3).
// An accent is DECORATION that tells two missions apart at a glance; it never encodes a status, a type or a
// priority. Meaning always comes from text + glyph (StatusBadge, labels). Colours live in tokens.css and are mapped
// to `--mui-fg` / `--mui-soft` by `[data-hue]` in missionUi.css.

export const MISSION_ACCENTS = ['green', 'blue', 'amber', 'purple', 'teal', 'indigo'] as const
export type MissionAccent = (typeof MISSION_ACCENTS)[number]

// Hues usable on a chart segment or a KPI tile: the six accents plus the semantic ones.
export type MissionHue = MissionAccent | 'success' | 'danger' | 'neutral'

// Stable accent of a mission: same id -> same colour on the list card, the detail header and the statistics.
// A hash of the id, not a stored field: no new domain concept, no migration.
export function accentForMission(id: string): MissionAccent {
  let hash = 0
  for (let index = 0; index < id.length; index++) hash = (hash * 31 + id.charCodeAt(index)) >>> 0
  return MISSION_ACCENTS[hash % MISSION_ACCENTS.length] as MissionAccent
}

// Card glyph per mission type (the card read model carries `type`, not the result kind).
export const MISSION_TYPE_ICONS: Record<MissionType, IconComponent> = {
  prospection: CompassIcon,
  signals: RadarIcon,
  enrichment: PencilIcon,
  verification: ShieldCheckIcon,
  other: SparklesIcon,
}
