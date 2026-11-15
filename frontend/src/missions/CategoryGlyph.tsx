import type { CSSProperties } from 'react'

import type { MissionCategoryRef, MissionType } from '../api/missions'
import { SparklesIcon } from '../ui/icons'
import enrichmentArt from '../assets/mission/enrichment.png'
import prospectionArt from '../assets/mission/prospection.png'
import signalsArt from '../assets/mission/signals.png'
import verificationArt from '../assets/mission/verification.png'
import { CATEGORY_ICONS, TYPE_FALLBACK_ICON } from './categoryVisual'

// The illustration of the four built-in kinds of mission (prospection, signaux, enrichissement, vérification).
// A category made by an administrator, and « Autre », keep their glyph.
const KIND_ART: Partial<Record<string, string>> = {
  prospection: prospectionArt,
  signals: signalsArt,
  enrichment: enrichmentArt,
  verification: verificationArt,
}

function artOf(category: MissionCategoryRef | null | undefined, type: MissionType): string | undefined {
  if (category) return category.key ? KIND_ART[category.key] : undefined
  return KIND_ART[type]
}

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

// The identity mark of a mission: a bordered circle (the category's colour) holding the illustration of its kind, or
// the glyph of a custom category. Decoration: the kind is always also written (the category badge / title).
export function MissionMark({
  category,
  type,
  size,
}: {
  category: MissionCategoryRef | null | undefined
  type: MissionType
  size: number
}) {
  const art = artOf(category, type)
  return (
    <span className="mission-mark" style={{ '--mark-size': `${String(size / 16)}rem` } as CSSProperties} aria-hidden="true">
      {art ? <img className="mission-mark__art" src={art} alt="" draggable={false} /> : <MissionGlyph category={category} type={type} size={Math.round(size * 0.5)} />}
    </span>
  )
}
