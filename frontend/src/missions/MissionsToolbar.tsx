import type { MissionType } from '../api/missions'
import { Button } from '../ui/Button'
import { SelectField } from '../ui/fields'
import { MISSION_TYPE_LABELS } from './labels'
import {
  DEFAULT_FILTERS,
  isFiltered,
  type ListFilters,
  SORT_OPTIONS,
  type SortKey,
  STATUS_FILTER_OPTIONS,
  type StatusFilter,
  type TypeFilter,
} from './missionsListModel'
import './missionsList.css'

const TYPES = Object.keys(MISSION_TYPE_LABELS) as MissionType[]

interface MissionsToolbarProps {
  filters: ListFilters
  onChange: (filters: ListFilters) => void
}

// Statut / Type filters (left) and Tri (right). Native selects: keyboard, touch and screen readers for free.
export function MissionsToolbar({ filters, onChange }: MissionsToolbarProps) {
  return (
    <div className="mlist-toolbar" role="group" aria-label="Filtrer et trier les missions">
      <SelectField
        label="Statut"
        className="mlist-toolbar__select"
        value={filters.status}
        onChange={(event) => {
          onChange({ ...filters, status: event.target.value as StatusFilter })
        }}
      >
        {STATUS_FILTER_OPTIONS.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </SelectField>
      <SelectField
        label="Type"
        className="mlist-toolbar__select"
        value={filters.type}
        onChange={(event) => {
          onChange({ ...filters, type: event.target.value as TypeFilter })
        }}
      >
        <option value="all">Tous les types</option>
        {TYPES.map((type) => (
          <option key={type} value={type}>
            {MISSION_TYPE_LABELS[type]}
          </option>
        ))}
      </SelectField>
      {isFiltered(filters) && (
        <Button
          size="sm"
          variant="ghost"
          onClick={() => {
            onChange({ ...DEFAULT_FILTERS, sort: filters.sort })
          }}
        >
          Réinitialiser les filtres
        </Button>
      )}
      <SelectField
        label="Tri"
        className="mlist-toolbar__select mlist-toolbar__sort"
        value={filters.sort}
        onChange={(event) => {
          onChange({ ...filters, sort: event.target.value as SortKey })
        }}
      >
        {SORT_OPTIONS.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </SelectField>
    </div>
  )
}
