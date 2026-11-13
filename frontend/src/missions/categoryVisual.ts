import type { CSSProperties } from 'react'

import type { MissionType } from '../api/missions'
import {
  BoltIcon,
  BuildingIcon,
  CalendarIcon,
  CompassIcon,
  DatabaseIcon,
  type IconComponent,
  LinkIcon,
  MailIcon,
  MapPinIcon,
  PencilIcon,
  RadarIcon,
  SearchIcon,
  ShieldCheckIcon,
  SparklesIcon,
  TargetIcon,
  TruckIcon,
  UserPlusIcon,
  UsersIcon,
  WarehouseIcon,
} from '../ui/icons'

// A mission category owns its visual identity (icon + colour, set by an administrator). It is DECORATION that tells
// categories apart at a glance; a status, a type or a priority always reads from text + glyph, never from this colour.
// The API stores a glyph key (`shield-check`); this is the closed set the editor offers and the UI can draw.
export const CATEGORY_ICONS: Record<string, { icon: IconComponent; label: string }> = {
  compass: { icon: CompassIcon, label: 'Boussole' },
  radar: { icon: RadarIcon, label: 'Radar' },
  pencil: { icon: PencilIcon, label: 'Crayon' },
  'shield-check': { icon: ShieldCheckIcon, label: 'Bouclier' },
  sparkles: { icon: SparklesIcon, label: 'Étincelles' },
  target: { icon: TargetIcon, label: 'Cible' },
  search: { icon: SearchIcon, label: 'Loupe' },
  users: { icon: UsersIcon, label: 'Personnes' },
  'user-plus': { icon: UserPlusIcon, label: 'Nouveau contact' },
  building: { icon: BuildingIcon, label: 'Société' },
  warehouse: { icon: WarehouseIcon, label: 'Entrepôt' },
  truck: { icon: TruckIcon, label: 'Camion' },
  'map-pin': { icon: MapPinIcon, label: 'Lieu' },
  mail: { icon: MailIcon, label: 'Courrier' },
  calendar: { icon: CalendarIcon, label: 'Calendrier' },
  database: { icon: DatabaseIcon, label: 'Données' },
  link: { icon: LinkIcon, label: 'Lien' },
  bolt: { icon: BoltIcon, label: 'Éclair' },
}

// A category colour is administrator data (`#RRGGBB`, what <input type="color"> and the API speak), not a themed UI
// colour: the default is written as a number so no raw colour literal lives outside theme/tokens.css.
export function hexColor(rgb: number): string {
  return `#${rgb.toString(16).padStart(6, '0')}`
}

export const DEFAULT_CATEGORY_COLOR = hexColor(0x16a34a)

// An unknown key (a glyph added later by the API) still draws something.
export function categoryIcon(key: string | null | undefined): IconComponent {
  return CATEGORY_ICONS[key ?? '']?.icon ?? SparklesIcon
}

// Legacy fallback when a card carries no category (a row older than the categories): the icon of its technical type.
export const TYPE_FALLBACK_ICON: Record<MissionType, string> = {
  prospection: 'compass',
  signals: 'radar',
  enrichment: 'pencil',
  verification: 'shield-check',
  other: 'sparkles',
}

// `--mui-fg` / `--mui-soft` (missionUi.css) from the category colour: the glyph keeps the hue mixed toward the text
// colour so it stays readable on both themes whatever colour an administrator picks; the tile is a light tint.
export function categoryAccent(color: string | null | undefined): CSSProperties | undefined {
  if (!color || !/^#[0-9a-fA-F]{6}$/.test(color)) return undefined
  return {
    '--mui-fg': `color-mix(in srgb, ${color} 62%, var(--color-text))`,
    '--mui-soft': `color-mix(in srgb, ${color} 16%, transparent)`,
  } as CSSProperties
}
