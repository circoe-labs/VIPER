import type { ReactNode } from 'react'

import { useCompanies } from '../api/companies'
import { useImportHistory } from '../api/imports'
import { NONE, TRACKING_STATUSES } from '../api/prospection'
import { type Cohort, referentName, useCohorts, useReferents, useTaxonomyValues } from '../api/settings'
import { calendarDate } from '../lib/calendarDate'
import { COMPANY_KIND_LABELS } from '../api/companies'
import { ActiveChips, ControlBar, FilterMenu, SortSelect } from '../ui/ControlBar'
import { Combobox } from '../ui/Combobox'
import { SelectField, TextField } from '../ui/fields'
import { clearedFilters, ENTITY_SORTS, type ProspectionView, sortFor, type ViewSort } from './criteria'
import { activeFilters, CONTACT_QUICK_FILTERS, type FilterNames, NO_NAMES, QUICK_FILTERS, type QuickFilter } from './filterChips'
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

// One control row: [search] [Trier par] [Filtres] | [applied filters] (ui/ControlBar). Filters never change the entity:
// they only restrict its list (filterChips.ts models them; every applied one is a removable chip and lives in the URL).
export function ProspectionControls({ view, onChange, search }: ProspectionControlsProps) {
  return (
    <ControlBar
      search={search}
      sort={<SortControl view={view} onChange={onChange} />}
      filters={<FiltersMenu view={view} onChange={onChange} />}
      active={view.entity === 'prospect' ? <ProspectActiveFilters view={view} onChange={onChange} /> : <ActiveFilters view={view} onChange={onChange} />}
    />
  )
}

function SortControl({ view, onChange }: Pick<ProspectionControlsProps, 'view' | 'onChange'>) {
  return (
    <SortSelect
      value={sortFor(view)}
      options={ENTITY_SORTS[view.entity].map((sort) => ({ value: sort, label: view.entity !== 'prospect' && sort === 'updated' ? 'Dernière modification' : SORT_LABELS[sort] }))}
      onChange={(sort) => { onChange({ sort: sort as ViewSort }) }}
    />
  )
}

function ActiveFilters({ view, onChange, names = NO_NAMES }: Pick<ProspectionControlsProps, 'view' | 'onChange'> & { names?: FilterNames }) {
  const chips = activeFilters(view, names).map((chip) => ({ id: chip.id, label: chip.label, onRemove: () => { onChange(chip.clear) } }))
  return <ActiveChips chips={chips} onClear={() => { onChange(clearedFilters(view.entity)) }} />
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

function QuickGroup({ title, label = title, filters, view, onChange }: { title: string; label?: string; filters: readonly QuickFilter[]; view: ProspectionView; onChange: (patch: Partial<ProspectionView>) => void }) {
  return (
    <div className="filters-menu__group" role="group" aria-label={label}>
      <span className="filters-menu__title" aria-hidden="true">{title}</span>
      <div className="filters-menu__quick">
        {filters.map((filter) => {
          const active = filter.active(view)
          return (
            <button key={filter.id} type="button" className="filters-menu__option" aria-pressed={active} title={filter.hint} onClick={() => { onChange(active ? filter.clear : filter.apply) }}>
              {filter.label}
            </button>
          )
        })}
      </div>
    </div>
  )
}

// « Filtres »: quick filters of the entity first (validation status, contact status, type), then the advanced ones the
// API supports.
function FiltersMenu({ view, onChange }: Pick<ProspectionControlsProps, 'view' | 'onChange'>) {
  const count = activeFilters(view).length
  const quick = QUICK_FILTERS[view.entity]
  const titles: Record<ProspectionView['entity'], string> = { prospect: 'Statut du prospect', company: 'Type d’entreprise', warehouse: 'Catégorie' }
  return (
    <FilterMenu count={count}>
      {(open) => (
        <>
          <QuickGroup title={titles[view.entity]} label="Filtres rapides" filters={quick} view={view} onChange={onChange} />
          {view.entity === 'prospect' && <QuickGroup title="État de contact" filters={CONTACT_QUICK_FILTERS} view={view} onChange={onChange} />}
          {view.entity !== 'warehouse' && <CreationDates view={view} onChange={onChange} />}
          {view.entity === 'prospect' && open && <ProspectFilterFields view={view} onChange={onChange} />}
        </>
      )}
    </FilterMenu>
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
      <SelectField label="Semaine de contact" value={view.cohort ?? ''} onChange={(event) => { onChange({ cohort: orNull(event.target.value) }) }}>
        <option value="">Toutes les semaines de contact</option>
        <option value={NONE}>Sans semaine de contact (non validé)</option>
        {view.cohort && view.cohort !== NONE && !(cohorts.data ?? []).some((cohort) => cohort.id === view.cohort) && <option value={view.cohort}>Semaine de contact sélectionnée</option>}
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
      <SelectField label="Type d’entreprise" value={view.company_kind ?? ''} onChange={(event) => { onChange({ company_kind: orNull(event.target.value) }) }}>
        <option value="">Tous les types</option>
        {(Object.keys(COMPANY_KIND_LABELS) as (keyof typeof COMPANY_KIND_LABELS)[]).map((kind) => <option key={kind} value={kind}>{COMPANY_KIND_LABELS[kind]}</option>)}
        <option value="unclassified">À classer</option>
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
