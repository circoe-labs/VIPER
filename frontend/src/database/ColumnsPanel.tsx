import type { ExplorerColumn } from '../api/explorer'
import { Button, IconButton } from '../ui/Button'
import { Checkbox } from '../ui/fields'
import { ChevronLeftIcon, ChevronRightIcon, PinIcon } from '../ui/icons'
import { type ColumnAction, type ColumnState, displayOrder } from './columnState'

interface ColumnsPanelProps {
  columns: ExplorerColumn[]
  state: ColumnState
  onAction: (action: ColumnAction) => void
}

// Column chooser (toolbar "Colonnes"): visibility, pinning and order, all keyboard-operable.
export function ColumnsPanel({ columns, state, onAction }: ColumnsPanelProps) {
  const visible = displayOrder(state)
  // Displayed columns in display order, then hidden ones in their stored order.
  const listed = [...visible, ...state.order.filter((name) => state.hidden.includes(name))]
  const byName = new Map(columns.map((column) => [column.name, column]))

  return (
    <div className="columns-panel">
      <div className="columns-panel__heading">
        <p className="columns-panel__title">Colonnes</p>
        <p className="columns-panel__summary">
          {visible.length} / {columns.length} affichées
        </p>
      </div>
      <ul className="columns-panel__list">
        {listed.map((name) => {
          const column = byName.get(name)
          const shown = visible.includes(name)
          const pinned = state.pinned.includes(name)
          return (
            <li key={name} className="columns-panel__item" data-hidden={shown ? undefined : ''}>
              <Checkbox
                label={name}
                checked={shown}
                disabled={shown && visible.length === 1}
                onChange={() => {
                  onAction({ type: 'toggle', column: name })
                }}
              />
              <span className="columns-panel__type">{column?.sql_type}</span>
              <span className="columns-panel__tools">
                <IconButton
                  icon={PinIcon}
                  size="sm"
                  variant={pinned ? 'secondary' : 'ghost'}
                  label={pinned ? `Désépingler ${name}` : `Épingler ${name} à gauche`}
                  aria-pressed={pinned}
                  onClick={() => {
                    onAction({ type: 'pin', column: name, pinned: !pinned })
                  }}
                />
                <IconButton
                  icon={ChevronLeftIcon}
                  size="sm"
                  label={`Déplacer ${name} à gauche`}
                  disabled={!shown}
                  onClick={() => {
                    onAction({ type: 'move', column: name, offset: -1 })
                  }}
                />
                <IconButton
                  icon={ChevronRightIcon}
                  size="sm"
                  label={`Déplacer ${name} à droite`}
                  disabled={!shown}
                  onClick={() => {
                    onAction({ type: 'move', column: name, offset: 1 })
                  }}
                />
              </span>
            </li>
          )
        })}
      </ul>
      <div className="columns-panel__actions">
        <Button
          size="sm"
          variant="ghost"
          onClick={() => {
            onAction({ type: 'showAll' })
          }}
        >
          Tout afficher
        </Button>
        <Button
          size="sm"
          onClick={() => {
            onAction({ type: 'reset', columns })
          }}
        >
          Réinitialiser la disposition
        </Button>
      </div>
    </div>
  )
}
