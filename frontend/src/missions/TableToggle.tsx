import { type ReactNode, useState } from 'react'

import { IconButton } from '../ui/Button'
import { TableIcon } from '../ui/icons'

// Chart <-> table switch for a chart panel: put `button` in the panel's `actions` (top right) and pass `asTable` to the
// chart. State is local to the panel; the table always shows the same figures as the chart.
export function useTableToggle(): { asTable: boolean; button: ReactNode } {
  const [asTable, setAsTable] = useState(false)
  const button = (
    <IconButton
      size="md"
      variant={asTable ? 'primary' : 'secondary'}
      icon={TableIcon}
      label={asTable ? 'Afficher le graphique' : 'Afficher les données en tableau'}
      aria-pressed={asTable}
      onClick={() => {
        setAsTable((value) => !value)
      }}
    />
  )
  return { asTable, button }
}
