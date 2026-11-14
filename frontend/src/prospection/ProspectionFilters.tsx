import { type ReactNode, useState } from 'react'

import { useCompanies } from '../api/companies'
import { useImportHistory } from '../api/imports'
import { NONE, TRACKING_STATUSES } from '../api/prospection'
import { type Cohort, referentName, useCohorts, useReferents, useTaxonomyValues } from '../api/settings'
import { calendarDate } from '../lib/calendarDate'
import { Badge } from '../ui/Badge'
import { Button } from '../ui/Button'
import { Combobox } from '../ui/Combobox'
import { SelectField, TextField } from '../ui/fields'
import { ChevronDownIcon, CloseIcon, FilterIcon } from '../ui/icons'
import { clearedFilters, ENTITY_SORTS, type ProspectionView, sortFor, type ViewSort } from './criteria'
import { activeFilters, type FilterChip, type FilterNames, NO_NAMES, QUICK_FILTERS } from './filterChips'
import { ACTIVITY_LABELS, formatDay, SORT_LABELS, TRACKING_LABELS } from './labels'

interface ProspectionControlsProps {
  view: ProspectionView
  // Applies a patch to the URL view and goes back to page 1.
  onChange: (patch: Partial<ProspectionView>) => void
  // The page's search box (entity-specific placeholder), first of the row.
  search: ReactNode
}

// The API caps a list at 200 companies; the picker filters them as the user types.
const COMPANY_OPTIONS_LIMIT = 200

// '' is the « Tous » option; the other values are the option values listed below.
function orNull(value: string): never | null {
  return value === '' ? null : (value as never)
}

// One control row: [search] [Trier par] [Filtres] | [active filters]. Filters never change the entity: they only restrict
// its list (filterChips.ts models them; every applied one is a removable chip and lives in the URL).
export function ProspectionControls({ view, onChange, search }: ProspectionControlsProps) {
  return (
    <div className="prospection-controls">
      <div className="prospection-controls__search">{search}</div>
      <SortSelect view={view} onChange={onChange} />
      <FiltersMenu view={view} onChange={onChange} />
      <span className="prospection-controls__divider" aria-hidden="true" />
      {view.entity === 'prospect' ? <ProspectActiveFilters view={view} onChange={onChange} /> : <ActiveFilters view={view} onChange={onChange} />}
    </div>
  )
}

function SortSelect({ view, onChange }: Pick<ProspectionControlsProps, 'view' | 'onChange'>) {
  return (
    <div className="prospection-controls__sort">
      <SelectField label="Trier par" value={sortFor(view)} onChange={(event) => { onChange({ sort: event.target.value as ViewSort }) }}>
        {ENTITY_SORTS[view.entity].map((sort) => (
          <option key={sort} value={sort}>{view.entity !== 'prospect' && sort === 'updated' ? 'Dernière modification' : SORT_LABELS[sort]}</option>
        ))}
      </SelectField>
    </div>
  )
}

function ActiveFilters({ view, onChange, names = NO_NAMES }: Pick<ProspectionControlsProps, 'view' | 'onChange'> & { names?: FilterNames }) {
  const chips = activeFilters(view, names)
  return (
    <div className="prospection-controls__active" role="group" aria-label="Filtres appliqués">
      {chips.length === 0 && <span className="prospection-controls__none">Aucun filtre</span>}
      {chips.map((chip) => <Chip key={chip.id} chip={chip} onRemove={() => { onChange(chip.clear) }} />)}
      {chips.length > 0 && <Button size="sm" variant="ghost" onClick={() => { onChange(clearedFilters(view.entity)) }}>Tout effacer</Button>}
    </div>
  )
}

function Chip({ chip, onRemove }: { chip: FilterChip; onRemove: () => void }) {
  return (
    <span className="filter-chip">
      {chip.label}
      <button type="button" className="filter-chip__remove" aria-label={`Retirer le filtre : ${chip.label}`} onClick={onRemove}><CloseIcon size={12} /></button>
    </span>
  )
}

// The picked role / referent / cohort / company / import are shown by name, from the lists the filters already load.
function ProspectActiveFilters({ view, onChange }: Pick<ProspectionControlsProps, 'view' | 'onChange'>) {
  const roles = useTaxonomyValues('roles')
  const cohorts = useCohorts()
  const referents = useReferents()
  const companies = useCompanies('', 0, COMPANY_OPTIONS_LIMIT)
  const imports = useImportHistory()
  const names: FilterNames = {
    role: (id) => roles.data?.find((role) => role.id === id)?.label,
    cohort: (id) => { const cohort = cohorts.data?.find((item) => item.id === id); return cohort?.code },
    referent: (id) => { const referent = referents.data?.find((item) => item.id === id); return referent ? referentName(referent) : undefined },
    company: (id) => companies.data?.items.find((company) => company.id === id)?.display_name,
    import_batch: (id) => imports.data?.find((batch) => batch.id === id)?.filename,
  }
  return <ActiveFilters view={view} onChange={onChange} names={names} />
}

// « Filtres »: quick filters of the entity first, then the advanced ones the API supports (open by default when one is set).
function FiltersMenu({ view, onChange }: Pick<ProspectionControlsProps, 'view' | 'onChange'>) {
  const [open, setOpen] = useState(false)
  const count = activeFilters(view).length
  const quick = QUICK_FILTERS[view.entity]
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
      <div className="filters-menu__panel" hidden={!open}>
        <div className="filters-menu__quick" role="group" aria-label="Filtres rapides">
          {quick.map((filter) => {
            const active = filter.active(view)
            return (
              <button key={filter.id} type="button" className="filters-menu__option" aria-pressed={active} title={filter.hint} onClick={() => { onChange(active ? filter.clear : filter.apply) }}>
                {filter.label}
              </button>
            )
          })}
        </div>
        {view.entity !== 'warehouse' && <CreationDates view={view} onChange={onChange} />}
        {view.entity === 'prospect' && open && <ProspectFilterFields view={view} onChange={onChange} />}
      </div>
    </details>
  )
}

function CreationDates({ view, onChange }: Pick<ProspectionControlsProps, 'view' | 'onChange'>) {
  return (
    <div className="filters-menu__fields" role="group" aria-label="Date d’ajout">
      <TextField label="Ajoutés depuis le" type="date" value={view.created_from ?? ''} onChange={(event) => { onChange({ created_from: calendarDate(event.target.value) }) }} />
      <TextField label="Ajoutés jusqu’au" type="date" value={view.created_to ?? ''} onChange={(event) => { onChange({ created_to: calendarDate(event.target.value) }) }} />
    </div>
  )
}

// « S39 — 28 sept. 2026 », « S0 — hors campagne ».
function cohortOption(cohort: Cohort): string {
  if (cohort.out_of_campaign) return `${cohort.code} — hors campagne`
  return cohort.starts_on ? `${cohort.code} — ${formatDay(cohort.starts_on)}` : cohort.code
}

// Values come from Paramètres (roles, referents, cohorts = campagnes), the companies and the import history;
// « Sans … » options select people with no value (« Sans cohorte » : not validated).
function ProspectFilterFields({ view, onChange }: Pick<ProspectionControlsProps, 'view' | 'onChange'>) {
  const roles = useTaxonomyValues('roles')
  const cohorts = useCohorts()
  const referents = useReferents()
  const companies = useCompanies('', 0, COMPANY_OPTIONS_LIMIT)
  const imports = useImportHistory()
  const batches = (imports.data ?? []).filter((batch) => batch.status === 'committed')

  return (
    <div className="filters-menu__fields" role="group" aria-label="Filtres avancés">
      <SelectField label="Rôle" value={view.role ?? ''} onChange={(event) => { onChange({ role: orNull(event.target.value) }) }}>
        <option value="">Tous les rôles</option>
        <option value={NONE}>Sans rôle</option>
        {(roles.data ?? []).map((role) => (
          <option key={role.id} value={role.id}>{role.label}{role.active ? '' : ' (inactif)'}</option>
        ))}
      </SelectField>
      <SelectField label="Activité" value={view.activity ?? ''} onChange={(event) => { onChange({ activity: orNull(event.target.value) }) }}>
        <option value="">Toutes</option>
        {(['active', 'unknown', 'inactive'] as const).map((activity) => (
          <option key={activity} value={activity}>{ACTIVITY_LABELS[activity]}</option>
        ))}
      </SelectField>
      <SelectField label="Cohorte" value={view.cohort ?? ''} onChange={(event) => { onChange({ cohort: orNull(event.target.value) }) }}>
        <option value="">Toutes les cohortes</option>
        <option value={NONE}>Sans cohorte (non validé)</option>
        {view.cohort && view.cohort !== NONE && !(cohorts.data ?? []).some((cohort) => cohort.id === view.cohort) && <option value={view.cohort}>Cohorte sélectionnée</option>}
        {(cohorts.data ?? []).map((cohort) => (
          <option key={cohort.id} value={cohort.id}>{cohortOption(cohort)}</option>
        ))}
      </SelectField>
      <SelectField label="État commercial" value={view.tracking_status ?? ''} onChange={(event) => { onChange({ tracking_status: orNull(event.target.value) }) }}>
        <option value="">Tous les états</option>
        {TRACKING_STATUSES.map((status) => (
          <option key={status} value={status}>{TRACKING_LABELS[status]}</option>
        ))}
      </SelectField>
      <SelectField label="Référent" value={view.referent ?? ''} onChange={(event) => { onChange({ referent: orNull(event.target.value) }) }}>
        <option value="">Tous les référents</option>
        <option value={NONE}>Sans référent</option>
        {(referents.data ?? []).map((referent) => (
          <option key={referent.id} value={referent.id}>{referentName(referent)}</option>
        ))}
      </SelectField>
      <Combobox
        label="Entreprise"
        placeholder="Toutes les entreprises"
        options={(companies.data?.items ?? []).map((company) => ({ id: company.id, label: company.display_name }))}
        status={companies.isError ? 'error' : companies.isPending ? 'loading' : 'ready'}
        value={view.company}
        onChange={(company) => { onChange({ company }) }}
      />
      <SelectField label="Import" value={view.import_batch ?? ''} onChange={(event) => { onChange({ import_batch: orNull(event.target.value) }) }}>
        <option value="">Tous les imports</option>
        {view.import_batch && !batches.some((batch) => batch.id === view.import_batch) && <option value={view.import_batch}>Import sélectionné</option>}
        {batches.map((batch) => (
          <option key={batch.id} value={batch.id}>{batch.filename} — {formatDay(batch.committed_at ?? batch.created_at)}</option>
        ))}
      </SelectField>
    </div>
  )
}
