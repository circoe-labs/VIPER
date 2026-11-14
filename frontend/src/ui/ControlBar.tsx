import { type ReactNode, useState } from 'react'

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

// « Filtres »: a button that opens a panel (its children: quick options, fields) and shows how many filters apply.
// `open` is exposed so a panel can load its option lists only when needed.
export function FilterMenu({ count, children }: { count: number; children: (open: boolean) => ReactNode }) {
  const [open, setOpen] = useState(false)
  return (
    <details
      className="filters-menu"
      open={open}
      onToggle={(event) => { setOpen(event.currentTarget.open) }}
      onKeyDown={(event) => { if (event.key === 'Escape') { setOpen(false); event.currentTarget.querySelector('summary')?.focus() } }}
    >
      <summary className="btn btn--secondary btn--md" aria-label={count > 0 ? `Filtres (${String(count)} appliqués)` : 'Filtres'}>
        <FilterIcon size={18} />
        Filtres
        {count > 0 && <Badge tone="accent">{count}</Badge>}
        <ChevronDownIcon size={16} />
      </summary>
      <div className="filters-menu__panel" hidden={!open}>{children(open)}</div>
    </details>
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
