import { type ReactNode, useId, useState } from 'react'

import { useCompanies } from '../api/companies'
import { useImportHistory } from '../api/imports'
import { NONE, PROSPECT_SORTS, type ProspectSort, TRACKING_STATUSES } from '../api/prospection'
import { referentName, useReferents, useTaxonomyValues } from '../api/settings'
import { Badge } from '../ui/Badge'
import { Button } from '../ui/Button'
import { Combobox } from '../ui/Combobox'
import { SelectField } from '../ui/fields'
import { ChevronDownIcon, FilterIcon } from '../ui/icons'
import type { ProspectionView } from './criteria'
import { ACTIVITY_LABELS, formatDay, SORT_LABELS, TRACKING_LABELS } from './labels'

type FilterPatch = Partial<Pick<ProspectionView, 'role' | 'activity' | 'referent' | 'tracking_status' | 'company' | 'import_batch' | 'sort'>>

interface ProspectionFiltersProps {
  view: ProspectionView
  onChange: (patch: FilterPatch) => void
  // Search box, placed first in the toolbar.
  search: ReactNode
}

// The API caps a list at 200 companies; the picker filters them as the user types.
const COMPANY_OPTIONS_LIMIT = 200

// '' is the « Tous » option; the other values are the option values listed below.
function orNull(value: string): never | null {
  return value === '' ? null : (value as never)
}

// Search, sort and — behind « Filtres », open by default when one is set — the filters of the people list. Values come
// from Paramètres (roles, referents), the companies and the import history; « Sans … » options select people with no
// value.
export function ProspectionFilters({ view, onChange, search }: ProspectionFiltersProps) {
  const panelId = useId()
  const active = [view.role, view.activity, view.referent, view.tracking_status, view.company, view.import_batch].filter(
    (value) => value !== null,
  ).length
  const [open, setOpen] = useState(active > 0)

  return (
    <div className="prospection-toolbar">
      <div className="prospection-toolbar__row">
        <div className="prospection-toolbar__search">{search}</div>
        <Button
          icon={FilterIcon}
          aria-expanded={open}
          aria-controls={panelId}
          onClick={() => {
            setOpen(!open)
          }}
        >
          Filtres
          {active > 0 && <Badge tone="accent">{active}</Badge>}
          <ChevronDownIcon size={16} className={open ? 'prospection-toolbar__chevron--open' : undefined} />
        </Button>
        <div className="prospection-toolbar__sort">
          <SelectField
            label="Trier par"
            value={view.sort}
            onChange={(event) => {
              onChange({ sort: event.target.value as ProspectSort })
            }}
          >
            {PROSPECT_SORTS.map((sort) => (
              <option key={sort} value={sort}>
                {SORT_LABELS[sort]}
              </option>
            ))}
          </SelectField>
        </div>
      </div>
      {open && <FilterFields id={panelId} view={view} onChange={onChange} />}
    </div>
  )
}

function FilterFields({ id, view, onChange }: { id: string; view: ProspectionView; onChange: (patch: FilterPatch) => void }) {
  const roles = useTaxonomyValues('roles')
  const referents = useReferents()
  const companies = useCompanies('', 0, COMPANY_OPTIONS_LIMIT)
  const imports = useImportHistory()
  const batches = (imports.data ?? []).filter((batch) => batch.status === 'committed')

  return (
    <div id={id} className="prospection-filters" role="group" aria-label="Filtres">
      <SelectField
        label="Rôle"
        value={view.role ?? ''}
        onChange={(event) => {
          onChange({ role: orNull(event.target.value) })
        }}
      >
        <option value="">Tous les rôles</option>
        <option value={NONE}>Sans rôle</option>
        {(roles.data ?? []).map((role) => (
          <option key={role.id} value={role.id}>
            {role.label}
            {role.active ? '' : ' (inactif)'}
          </option>
        ))}
      </SelectField>
      <SelectField
        label="Activité"
        value={view.activity ?? ''}
        onChange={(event) => {
          onChange({ activity: orNull(event.target.value) })
        }}
      >
        <option value="">Toutes</option>
        {(['active', 'unknown', 'inactive'] as const).map((activity) => (
          <option key={activity} value={activity}>
            {ACTIVITY_LABELS[activity]}
          </option>
        ))}
      </SelectField>
      <SelectField
        label="Suivi de contact"
        value={view.tracking_status ?? ''}
        onChange={(event) => {
          onChange({ tracking_status: orNull(event.target.value) })
        }}
      >
        <option value="">Tous les stades</option>
        <option value={NONE}>Sans suivi</option>
        {TRACKING_STATUSES.map((status) => (
          <option key={status} value={status}>
            {TRACKING_LABELS[status]}
          </option>
        ))}
      </SelectField>
      <SelectField
        label="Référent"
        value={view.referent ?? ''}
        onChange={(event) => {
          onChange({ referent: orNull(event.target.value) })
        }}
      >
        <option value="">Tous les référents</option>
        <option value={NONE}>Sans référent</option>
        {(referents.data ?? []).map((referent) => (
          <option key={referent.id} value={referent.id}>
            {referentName(referent)}
          </option>
        ))}
      </SelectField>
      <Combobox
        label="Entreprise"
        placeholder="Toutes les entreprises"
        options={(companies.data?.items ?? []).map((company) => ({ id: company.id, label: company.display_name }))}
        status={companies.isError ? 'error' : companies.isPending ? 'loading' : 'ready'}
        value={view.company}
        onChange={(company) => {
          onChange({ company })
        }}
      />
      <SelectField
        label="Import"
        value={view.import_batch ?? ''}
        onChange={(event) => {
          onChange({ import_batch: orNull(event.target.value) })
        }}
      >
        <option value="">Tous les imports</option>
        {view.import_batch && !batches.some((batch) => batch.id === view.import_batch) && (
          <option value={view.import_batch}>Import sélectionné</option>
        )}
        {batches.map((batch) => (
          <option key={batch.id} value={batch.id}>
            {batch.filename} — {formatDay(batch.committed_at ?? batch.created_at)}
          </option>
        ))}
      </SelectField>
    </div>
  )
}
