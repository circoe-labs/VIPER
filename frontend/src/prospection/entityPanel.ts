import type { ReactNode } from 'react'

import type { Entity, ProspectionView } from './criteria'
import type { WeeklyAdditions } from './weeklyAdditions'

// What ProspectionPage hands to the panel of the selected entity. `update` writes the URL (criteria.ts); `refine`
// does it and goes back to page 1; `search` is the page's debounced search box (its value lives in `view.q`).
export interface EntityPanelProps {
  view: ProspectionView
  update: (patch: Partial<ProspectionView>, options?: { push?: boolean }) => void
  refine: (patch: Partial<ProspectionView>) => void
  search: ReactNode
}

// A capsule's weekly figure: undefined while loading (nothing shown), null when unavailable, else the number.
export function weeklyFor(weekly: WeeklyAdditions, entity: Entity): number | null | undefined {
  return weekly.state === 'loading' ? undefined : weekly.added[entity]
}
