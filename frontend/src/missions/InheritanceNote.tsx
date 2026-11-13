import type { ReactNode } from 'react'

import { Badge } from '../ui/Badge'
import { Button } from '../ui/Button'
import { UndoIcon } from '../ui/icons'
import './missionCategoryPicker.css'

// One line that says whether a field follows its category (« Hérité ») or is the mission's own (« Personnalisé »), with
// the way back. State is text + badge, never colour alone; shown only where a choice exists so the form stays calm.
export function InheritanceNote({
  inherited,
  categoryName,
  resetLabel,
  onReset,
  children,
}: {
  inherited: boolean
  categoryName: string | undefined
  resetLabel: string
  onReset: () => void
  children?: ReactNode
}) {
  return (
    <p className="minh">
      {inherited ? (
        <>
          <Badge>Hérité</Badge>
          {categoryName ? `Suit la catégorie « ${categoryName} ».` : 'Suit la catégorie.'}
        </>
      ) : (
        <>
          <Badge tone="accent">Personnalisé</Badge>
          <Button size="sm" variant="ghost" icon={UndoIcon} onClick={onReset}>
            {resetLabel}
          </Button>
        </>
      )}
      {children}
    </p>
  )
}
