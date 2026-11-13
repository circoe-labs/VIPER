import type { MissionCategoryRef, MissionType } from '../api/missions'
import { SparklesIcon } from '../ui/icons'
import { CATEGORY_ICONS, TYPE_FALLBACK_ICON } from './categoryVisual'

// The glyph of a category key; an unknown key still draws something.
export function CategoryGlyph({ iconKey, size }: { iconKey: string | null | undefined; size: number }) {
  const Icon = CATEGORY_ICONS[iconKey ?? '']?.icon ?? SparklesIcon
  return <Icon size={size} />
}

// The glyph of a mission card or header: its category's, else its technical type's (a row older than categories).
export function MissionGlyph({
  category,
  type,
  size,
}: {
  category: MissionCategoryRef | null | undefined
  type: MissionType
  size: number
}) {
  return <CategoryGlyph iconKey={category?.icon ?? TYPE_FALLBACK_ICON[type]} size={size} />
}
