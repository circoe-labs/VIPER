import { useMemo } from 'react'

import { filtersOf, type ProspectListCriteria } from '../api/prospection'
import { DEFAULT_VIEW } from '../prospection/criteria'
import type { ProspectQueue } from '../prospection/queue'
import { ProspectEditor } from '../prospects/ProspectEditor'

// A queue of one: the overlay opens a single person, with no list to walk (the arrows are off).
function singleQueue(id: string): ProspectQueue {
  const criteria: ProspectListCriteria = { ...filtersOf(DEFAULT_VIEW), segment: 'all', review: [], sort: 'name' }
  return {
    criteria,
    ids: [id],
    page: 1,
    total: 1,
    position: (other) => (other === id ? 1 : null),
    next: () => Promise.resolve(null),
    previous: () => Promise.resolve(null),
  }
}

// The prospect's whole sheet (profile, tracking…) over the current page: the same editor as Prospection, in its
// drawer, so the person is read — and corrected — without leaving the Contact workbench. Esc, the close button and a
// click outside close it (the editor asks first when something is unsaved).
export function ProspectOverlay({ prospectId, onClose }: { prospectId: string; onClose: () => void }) {
  const queue = useMemo(() => singleQueue(prospectId), [prospectId])
  return (
    <ProspectEditor
      target={prospectId}
      queue={queue}
      onNavigate={(target) => {
        if (target === null) onClose()
      }}
    />
  )
}
