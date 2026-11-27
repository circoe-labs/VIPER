import { type ReactNode, useEffect, useRef, useState } from 'react'

import { Badge } from './Badge'
import { Button } from './Button'
import { ChevronDownIcon, CloseIcon, FilterIcon, SortIcon, TagIcon } from './icons'
import './control-bar.css'

// The one control row of a list page (Prospection, Contact): [search] [Trier par] [Filtres] | [applied filters].
// Pages compose it from the parts below so every list looks and behaves the same.
export function ControlBar({ search, sort, filters, active }: { search: ReactNode; sort?: ReactNode; filters: ReactNode; active: ReactNode }) {
  return (
    <div className="control-bar">
      <div className="control-bar__search">{search}</div>
      {sort}
      {filters}
      <span className="control-bar__divider" aria-hidden="true" />
      {active}
    </div>
  )
}

interface SortSelectProps {
  value: string
  options: { value: string; label: string }[]
  onChange: (value: string) => void
}

// « Trier par » as a button-like control: a native select (keyboard and screen-reader friendly) dressed as the Filtres button.
export function SortSelect({ value, options, onChange }: SortSelectProps) {
  return (
    <label className="control-bar__sort btn btn--secondary btn--md">
      <SortIcon size={18} />
      <span>Trier par</span>
      <span className="control-bar__sort-value">{options.find((option) => option.value === value)?.label}</span>
      <select aria-label="Trier par" value={value} onChange={(event) => { onChange(event.target.value) }}>
        {options.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
      </select>
      <ChevronDownIcon size={16} />
    </label>
  )
}

interface FilterMenuProps {
  count: number
  children: (open: boolean) => ReactNode
  // Actions kept in view under the scrolling content; `close` shuts the panel.
  footer?: (close: () => void) => ReactNode
  onOpenChange?: (open: boolean) => void
}

// « Filtres »: a button that opens a panel (its children: quick options, fields) and shows how many filters apply.
// `open` is exposed so a panel can load its option lists only when needed.
export function FilterMenu({ count, children, footer, onOpenChange }: FilterMenuProps) {
  const [open, setOpen] = useState(false)
  // The panel opens whole on screen, its actions included.
  const panel = useRef<HTMLDivElement>(null)
  useEffect(() => {
    // Absent from the test DOM.
    if (open) (panel.current as Partial<HTMLDivElement> | null)?.scrollIntoView?.({ block: 'nearest' })
  }, [open])
  const change = (next: boolean) => {
    if (next === open) return
    setOpen(next)
    onOpenChange?.(next)
  }
  return (
    <details
      className="filters-menu"
      open={open}
      onToggle={(event) => { change(event.currentTarget.open) }}
      onKeyDown={(event) => { if (event.key === 'Escape') { change(false); event.currentTarget.querySelector('summary')?.focus() } }}
    >
      <summary className="btn btn--secondary btn--md" aria-label={count > 0 ? `Filtres (${String(count)} appliqués)` : 'Filtres'}>
        <FilterIcon size={18} />
        Filtres
        {count > 0 && <Badge tone="accent">{count}</Badge>}
        <ChevronDownIcon size={16} />
      </summary>
      <div ref={panel} className="filters-menu__panel" hidden={!open}>
        {children(open)}
        {footer && <div className="filters-menu__footer">{footer(() => { change(false) })}</div>}
      </div>
    </details>
  )
}

interface ApplyFilterMenuProps<T extends object> {
  count: number
  // The filters in force.
  applied: T
  // What « Réinitialiser » selects.
  cleared: Partial<T>
  // Called with the changed filters only, on « Valider ».
  onApply: (changes: Partial<T>) => void
  // Why the selection cannot be applied as it is, or null.
  refuse?: (draft: T) => string | null
  children: (draft: T, patch: (changes: Partial<T>) => void, open: boolean) => ReactNode
}

// « Filtres » applied on demand: the panel edits a draft, « Valider » applies it, closing the panel any other way
// (« Annuler », Esc, the button) drops it. Filters removed from outside while it is open (chips) stay removed: only
// what was changed in the panel is applied.
export function ApplyFilterMenu<T extends object>({ count, applied, cleared, onApply, refuse, children }: ApplyFilterMenuProps<T>) {
  const [changes, setChanges] = useState<Partial<T>>({})
  const draft: T = { ...applied, ...changes }
  const patch = (next: Partial<T>) => { setChanges((current) => ({ ...current, ...next })) }
  const refusal = refuse?.(draft) ?? null
  return (
    <FilterMenu
      count={count}
      onOpenChange={() => { setChanges({}) }}
      footer={(close) => (
        <>
          <Button size="sm" variant="ghost" onClick={() => { patch(cleared) }}>Réinitialiser</Button>
          {refusal && <span className="filters-menu__refusal" role="alert">{refusal}</span>}
          <Button size="sm" onClick={close}>Annuler</Button>
          <Button
            size="sm"
            variant="primary"
            disabled={refusal !== null}
            onClick={() => {
              if (Object.keys(changes).length > 0) onApply(changes)
              close()
            }}
          >
            Valider
          </Button>
        </>
      )}
    >
      {(open) => children(draft, patch, open)}
    </FilterMenu>
  )
}

export interface ChipData {
  id: string
  label: string
  onRemove: () => void
}

// The applied filters, each a removable chip; « Aucun filtre » when there is none.
export function ActiveChips({ chips, onClear }: { chips: ChipData[]; onClear: () => void }) {
  return (
    <div className="control-bar__active" role="group" aria-label="Filtres appliqués">
      <TagIcon size={16} />
      {chips.length === 0 && <span className="control-bar__none">Aucun filtre</span>}
      {chips.map((chip) => (
        <span key={chip.id} className="control-chip">
          {chip.label}
          <button type="button" className="control-chip__remove" aria-label={`Retirer le filtre : ${chip.label}`} onClick={chip.onRemove}><CloseIcon size={12} /></button>
        </span>
      ))}
      {chips.length > 0 && <Button size="sm" variant="ghost" onClick={onClear}>Tout effacer</Button>}
    </div>
  )
}
